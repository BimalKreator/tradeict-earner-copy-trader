import bcrypt from "bcrypt";
import type { Request, Response } from "express";
import { Role } from "@prisma/client";
import { createAuthController } from "../../../controllers/authController.js";
import { inspectAccessToken } from "../../../middleware/authMiddleware.js";
import {
  consumeLoginOtp,
  consumeResetOtp,
  OTP_FAIL_LIMIT,
  storeLoginOtp,
  storeResetOtp,
} from "../../../services/userAuthService.js";
import { TEST_ID_PREFIX } from "../fixtures.js";
import type { HarnessScenario } from "../types.js";

type CapturedRes = {
  statusCode: number;
  body: unknown;
};

function mockReq(body: Record<string, unknown>): Request {
  return {
    body,
    headers: {},
    cookies: {},
  } as unknown as Request;
}

function mockRes(): { rec: CapturedRes; res: Response } {
  const rec: CapturedRes = { statusCode: 200, body: undefined };
  const res = {
    status(code: number) {
      rec.statusCode = code;
      return res;
    },
    json(body: unknown) {
      rec.body = body;
      return res;
    },
    cookie() {
      return res;
    },
    clearCookie() {
      return res;
    },
  };
  return { rec, res: res as unknown as Response };
}

function throwNext(err?: unknown): void {
  if (err) throw err;
}

/**
 * 14.3 / 14.4 / 14.5 — allowlist is signup-only, tokens are revocable,
 * login vs reset OTPs are hashed and separated.
 */
export const p14AuthScenario: HarnessScenario = {
  name: "p14-auth",
  async run(ctx) {
    const { prisma, assert, fixtures } = ctx;
    const auth = createAuthController(prisma);
    const password = "HarnessAuth1!";
    const passwordHash = await bcrypt.hash(password, 12);

    const user = await fixtures.createTestUser(
      `${TEST_ID_PREFIX}P14-AUTH`,
      Role.USER,
    );
    await prisma.user.update({
      where: { id: user.id },
      data: { password: passwordHash },
    });

    // --- 14.3: off-allowlist domain can log in and reset; signup is refused ---
    const loginRes = mockRes();
    await auth.login(
      mockReq({ email: user.email, password }),
      loginRes.res,
      throwNext,
    );
    assert.assert(
      loginRes.rec.statusCode !== 403,
      "login is not blocked by email allowlist",
    );
    assert.equal(loginRes.rec.statusCode, 200, "login returns 200");
    const loginBody = loginRes.rec.body as { otpRequired?: boolean };
    assert.equal(loginBody.otpRequired, true, "login proceeds to OTP");

    const forgotRes = mockRes();
    await auth.forgotPassword(
      mockReq({ email: user.email }),
      forgotRes.res,
      throwNext,
    );
    assert.assert(
      forgotRes.rec.statusCode !== 403,
      "password reset request is not blocked by allowlist",
    );
    assert.equal(forgotRes.rec.statusCode, 200, "forgot-password returns 200");

    const signupEmail = `${TEST_ID_PREFIX}p14-signup@not-on-allowlist.invalid`.toLowerCase();
    const signupRes = mockRes();
    await auth.sendSignupOtp(
      mockReq({ email: signupEmail }),
      signupRes.res,
      throwNext,
    );
    assert.equal(signupRes.rec.statusCode, 403, "signup OTP refused off-allowlist");

    const registerRes = mockRes();
    await auth.registerWithOtp(
      mockReq({
        name: "Blocked Signup",
        email: signupEmail,
        mobile: "9999999999",
        password,
        otp: "123456",
      }),
      registerRes.res,
      throwNext,
    );
    assert.equal(
      registerRes.rec.statusCode,
      403,
      "register refused off-allowlist",
    );

    // --- 14.4: bumping tokenVersion invalidates a previously minted token ---
    const versionBefore = await prisma.user.findUniqueOrThrow({
      where: { id: user.id },
      select: { tokenVersion: true },
    });
    const liveToken = fixtures.mintUserToken(
      user.id,
      user.email,
      Role.USER,
      versionBefore.tokenVersion,
    );
    const authed = await inspectAccessToken(prisma, liveToken);
    assert.equal(authed.ok, true, "token works before version bump");

    await prisma.user.update({
      where: { id: user.id },
      data: { tokenVersion: { increment: 1 } },
    });
    const afterBump = await inspectAccessToken(prisma, liveToken);
    assert.equal(afterBump.ok, false, "token rejected after tokenVersion bump");
    if (!afterBump.ok) {
      assert.equal(afterBump.status, 401, "bumped token is 401");
    }

    // Password reset bumps tokenVersion so a pre-reset token is dead
    const resetCode = "654321";
    await storeResetOtp(prisma, user.id, resetCode);
    const preReset = await prisma.user.findUniqueOrThrow({
      where: { id: user.id },
      select: { tokenVersion: true },
    });
    const tokenBeforeReset = fixtures.mintUserToken(
      user.id,
      user.email,
      Role.USER,
      preReset.tokenVersion,
    );

    const resetRes = mockRes();
    await auth.resetPassword(
      mockReq({
        email: user.email,
        otp: resetCode,
        newPassword: "HarnessAuth2!",
      }),
      resetRes.res,
      throwNext,
    );
    assert.equal(resetRes.rec.statusCode, 200, "password reset succeeds");

    const afterReset = await prisma.user.findUniqueOrThrow({
      where: { id: user.id },
      select: { tokenVersion: true },
    });
    assert.assert(
      afterReset.tokenVersion > preReset.tokenVersion,
      "password reset increments tokenVersion",
    );
    const deadAfterReset = await inspectAccessToken(prisma, tokenBeforeReset);
    assert.equal(
      deadAfterReset.ok,
      false,
      "token minted before password reset is dead",
    );
    if (!deadAfterReset.ok) {
      assert.equal(deadAfterReset.status, 401, "pre-reset token is 401");
    }

    // --- 14.5: login OTP cannot complete reset, and vice versa ---
    const loginOtp = "111111";
    const resetOtp = "222222";
    await storeLoginOtp(prisma, user.id, loginOtp);
    await storeResetOtp(prisma, user.id, resetOtp);

    const loginAsReset = await consumeResetOtp(prisma, user.id, loginOtp);
    assert.equal(
      loginAsReset,
      "invalid",
      "login OTP cannot complete a password reset",
    );

    const resetAsLogin = await consumeLoginOtp(prisma, user.id, resetOtp);
    assert.equal(
      resetAsLogin,
      "invalid",
      "reset OTP cannot complete a login",
    );

    const loginOk = await consumeLoginOtp(prisma, user.id, loginOtp);
    assert.equal(loginOk, "ok", "login OTP still valid for login");
    const resetOk = await consumeResetOtp(prisma, user.id, resetOtp);
    assert.equal(resetOk, "ok", "reset OTP still valid for reset");

    // 6th wrong attempt clears the code; stale correct code then fails
    const lockedCode = "333333";
    await storeLoginOtp(prisma, user.id, lockedCode);
    for (let i = 1; i <= OTP_FAIL_LIMIT; i += 1) {
      const result = await consumeLoginOtp(prisma, user.id, "000000");
      assert.equal(result, "invalid", `wrong login OTP attempt ${i} fails`);
    }
    const stale = await consumeLoginOtp(prisma, user.id, lockedCode);
    assert.equal(
      stale,
      "invalid",
      "stale login OTP fails after 6 wrong attempts cleared the hash",
    );
  },
};
