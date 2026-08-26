import { AdminRole, Role } from "@prisma/client";
import type { Request, Response } from "express";
import { createAdminController } from "../../../controllers/adminController.js";
import {
  authenticateJwt,
  requireAdmin,
} from "../../../middleware/authMiddleware.js";
import { walletAdjustConfirmationPhrase } from "../../../utils/requireTypedConfirmation.js";
import { TEST_ID_PREFIX } from "../fixtures.js";
import type { HarnessScenario } from "../types.js";

type CapturedRes = {
  statusCode: number;
  body: unknown;
};

function mockReq(init: {
  body?: Record<string, unknown>;
  params?: Record<string, string>;
  headers?: Record<string, string>;
  cookies?: Record<string, string>;
  userId?: string;
}): Request {
  return {
    body: init.body ?? {},
    params: init.params ?? {},
    headers: init.headers ?? {},
    cookies: init.cookies ?? {},
    userId: init.userId,
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
    send() {
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

function runMiddleware(
  mw: (req: Request, res: Response, next: (err?: unknown) => void) => void,
  req: Request,
  res: Response,
): Promise<"next" | "ended"> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const end = () => {
      if (!settled) {
        settled = true;
        resolve("ended");
      }
    };
    const originalStatus = res.status.bind(res);
    res.status = ((code: number) => {
      const out = originalStatus(code);
      // status alone does not end; wait for json
      return out;
    }) as Response["status"];
    const originalJson = res.json.bind(res);
    res.json = ((body: unknown) => {
      const out = originalJson(body);
      end();
      return out;
    }) as Response["json"];

    mw(req, res, (err?: unknown) => {
      if (err) {
        reject(err);
        return;
      }
      if (!settled) {
        settled = true;
        resolve("next");
      }
    });
  });
}

/**
 * 14.6 / 14.7 / 14.8 — admin guards: typed confirmation on wallet adjust +
 * user delete; customer tokens cannot reach admin routes.
 */
export const p14AdminGuardsScenario: HarnessScenario = {
  name: "p14-admin-guards",
  async run(ctx) {
    const { prisma, assert, fixtures } = ctx;
    const adminCtrl = createAdminController(prisma);

    const target = await fixtures.createTestUser(
      `${TEST_ID_PREFIX}P14-ADM-TGT`,
      Role.USER,
    );
    const customer = await fixtures.createTestUser(
      `${TEST_ID_PREFIX}P14-ADM-CUST`,
      Role.USER,
    );
    const adminUser = await fixtures.createTestUser(
      `${TEST_ID_PREFIX}P14-ADM-ADM`,
      Role.ADMIN,
    );
    await prisma.user.update({
      where: { id: adminUser.id },
      data: { adminRole: AdminRole.SUPER_ADMIN },
    });

    // --- Wallet adjust without confirmation ---
    {
      const { rec, res } = mockRes();
      await adminCtrl.adjustUserWallet(
        mockReq({
          params: { userId: target.id },
          body: { amount: 10, type: "ADD", reason: "harness" },
          userId: adminUser.id,
        }),
        res,
        (err) => {
          if (err) throw err;
        },
      );
      assert.equal(rec.statusCode, 400, "wallet adjust without confirmation → 400");
      const body = rec.body as { error?: string };
      assert.equal(
        body.error,
        "Typed confirmation required",
        "wallet adjust without confirmation names typed confirmation",
      );
    }

    // --- Wallet adjust with wrong confirmation ---
    {
      const { rec, res } = mockRes();
      await adminCtrl.adjustUserWallet(
        mockReq({
          params: { userId: target.id },
          body: {
            amount: 10,
            type: "REMOVE",
            reason: "harness",
            confirmation: "WRONG PHRASE",
          },
          userId: adminUser.id,
        }),
        res,
        (err) => {
          if (err) throw err;
        },
      );
      assert.equal(
        rec.statusCode,
        400,
        "wallet adjust with wrong confirmation → 400",
      );
      const expected = walletAdjustConfirmationPhrase(
        "REMOVE",
        10,
        target.email,
      );
      const body = rec.body as { expectedHint?: string };
      assert.assert(
        typeof body.expectedHint === "string" &&
          body.expectedHint.includes(expected),
        "wrong confirmation returns expectedHint with correct phrase",
      );
    }

    // --- User delete without confirmation ---
    {
      const { rec, res } = mockRes();
      await adminCtrl.deleteUserSafely(
        mockReq({
          params: { id: target.id },
          body: {},
          userId: adminUser.id,
        }),
        res,
        (err) => {
          if (err) throw err;
        },
      );
      assert.equal(rec.statusCode, 400, "user delete without confirmation → 400");
      const body = rec.body as { error?: string };
      assert.equal(
        body.error,
        "Typed confirmation required",
        "user delete without confirmation names typed confirmation",
      );
      const stillThere = await prisma.user.findUnique({
        where: { id: target.id },
        select: { id: true },
      });
      assert.assert(stillThere != null, "user still exists after refused delete");
    }

    // --- Customer token cannot reach admin route ---
    {
      const req = mockReq({
        headers: { authorization: `Bearer ${customer.token}` },
      });
      const { rec, res } = mockRes();
      const authMw = authenticateJwt(prisma);
      const adminMw = requireAdmin(prisma);

      const authResult = await runMiddleware(authMw, req, res);
      assert.equal(
        authResult,
        "next",
        "customer JWT authenticates (not an auth failure)",
      );
      assert.equal(
        req.userId,
        customer.id,
        "customer userId set on request",
      );

      const adminResult = await runMiddleware(adminMw, req, res);
      assert.equal(adminResult, "ended", "requireAdmin ends the request");
      assert.equal(rec.statusCode, 403, "customer cannot reach admin route");
      const body = rec.body as { error?: string };
      assert.equal(
        body.error,
        "Admin access required",
        "customer denied with Admin access required",
      );
    }
  },
};
