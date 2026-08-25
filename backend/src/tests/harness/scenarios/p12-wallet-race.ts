import { Role } from "@prisma/client";
import { requestWalletWithdrawal } from "../../../services/walletWithdrawalService.js";
import { TEST_ID_PREFIX } from "../fixtures.js";
import type { HarnessScenario, ScenarioContext } from "../types.js";

async function createWalletTestUser(
  ctx: ScenarioContext,
  markerSuffix: string,
): Promise<{ id: string }> {
  const user = await ctx.fixtures.createTestUser(
    `${TEST_ID_PREFIX}${markerSuffix}`,
    Role.USER,
  );
  await ctx.prisma.user.update({
    where: { id: user.id },
    data: {
      bankName: "Harness Test Bank",
      bankAccountNumber: "999988887777",
      bankIfsc: "HDFC0001234",
    },
  });
  return { id: user.id };
}

export const p12WalletRaceScenario: HarnessScenario = {
  name: "p12-wallet-race",
  async run(ctx) {
    const { prisma, assert } = ctx;

    const raceUser = await createWalletTestUser(ctx, "WALLET-RACE");
    await prisma.wallet.create({
      data: {
        userId: raceUser.id,
        balance: 100,
        lockedBalance: 0,
        pendingFees: 0,
      },
    });

    const [first, second] = await Promise.all([
      requestWalletWithdrawal(prisma, raceUser.id, 100),
      requestWalletWithdrawal(prisma, raceUser.id, 100),
    ]);

    const successes = [first, second].filter((row) => row.ok);
    const failures = [first, second].filter((row) => !row.ok);
    assert.equal(successes.length, 1, "exactly one concurrent withdrawal succeeds");
    assert.equal(failures.length, 1, "exactly one concurrent withdrawal fails");

    const walletAfterRace = await prisma.wallet.findUniqueOrThrow({
      where: { userId: raceUser.id },
    });
    assert.near(walletAfterRace.balance, 0, "balance after race");
    assert.near(walletAfterRace.lockedBalance, 100, "lockedBalance after race");
    assert.assert(
      walletAfterRace.balance >= 0 && walletAfterRace.lockedBalance >= 0,
      "wallet balances never negative after race",
    );

    const pendingUser = await createWalletTestUser(ctx, "WALLET-FEES");
    await prisma.wallet.create({
      data: {
        userId: pendingUser.id,
        balance: 100,
        lockedBalance: 0,
        pendingFees: 40,
      },
    });

    const blocked = await requestWalletWithdrawal(prisma, pendingUser.id, 70);
    assert.assert(
      blocked.ok === false &&
        blocked.message.includes("is held against unpaid platform fees"),
      "withdrawal blocked when pendingFees reserve funds",
    );

    const allowed = await requestWalletWithdrawal(prisma, pendingUser.id, 60);
    assert.assert(allowed.ok === true, "withdrawal succeeds within available funds");

    const walletAfterFees = await prisma.wallet.findUniqueOrThrow({
      where: { userId: pendingUser.id },
    });
    assert.near(walletAfterFees.balance, 40, "balance after pendingFees withdrawal");
    assert.near(
      walletAfterFees.lockedBalance,
      60,
      "lockedBalance after pendingFees withdrawal",
    );
  },
};
