import { Role, SubscriptionStatus } from "@prisma/client";
import {
  connectExchangeAccountForUser,
  disconnectExchangeAccountForUser,
} from "../../../controllers/exchangeAccountController.js";
import {
  installBotBridgeHarnessHooks,
  resetBotBridgeHarnessHooks,
  type BotSlaveResult,
  type CloseSlaveStructureResult,
  type DeltaKeyValidationResult,
} from "../../../services/botBridgeService.js";
import {
  modifySubscriptionCapital,
  pauseSubscriptionForUser,
} from "../../../services/subscriptionLifecycleService.js";
import { TEST_ID_PREFIX } from "../fixtures.js";
import type { HarnessScenario } from "../types.js";

/**
 * 13.7 / 13.8 / 13.9 — connect validation, safe disconnect, idempotent pause/capital.
 * Mocks the bot bridge — never calls live Delta or the real bot.
 */
export const p13AccountLifecycleScenario: HarnessScenario = {
  name: "p13-account-lifecycle",
  async run(ctx) {
    const { prisma, assert, fixtures } = ctx;
    let strategyId: string | null = null;

    try {
      // --- 13.7: mocked bot rejects keys → 4xx, no ExchangeAccount, no ACTIVE ---
      const rejectUser = await fixtures.createTestUser(
        `${TEST_ID_PREFIX}P13-REJECT`,
        Role.USER,
      );

      installBotBridgeHarnessHooks({
        validateDeltaKeysForTrading: async (): Promise<DeltaKeyValidationResult> => ({
          ok: false,
          reason: "bad_key",
          error: "Invalid Delta API key or secret.",
          status: 400,
        }),
      });

      const rejected = await connectExchangeAccountForUser(prisma, rejectUser.id, {
        nickname: `${TEST_ID_PREFIX}bad-keys`,
        apiKey: "fake-key",
        apiSecret: "fake-secret",
      });
      assert.equal(rejected.ok, false, "connect with rejected keys fails");
      if (!rejected.ok) {
        assert.assert(
          rejected.status >= 400 && rejected.status < 500,
          `rejected connect returns 4xx (got ${rejected.status})`,
        );
      }

      const accountsAfterReject = await prisma.exchangeAccount.count({
        where: { userId: rejectUser.id },
      });
      assert.equal(accountsAfterReject, 0, "no ExchangeAccount row after reject");

      const activeAfterReject = await prisma.userStrategySubscription.count({
        where: {
          userId: rejectUser.id,
          status: SubscriptionStatus.ACTIVE,
        },
      });
      assert.equal(activeAfterReject, 0, "no ACTIVE subscription after reject");

      resetBotBridgeHarnessHooks();

      // Shared strategy + user for disconnect / pause / capital
      const user = await fixtures.createTestUser(
        `${TEST_ID_PREFIX}P13-LIFE`,
        Role.USER,
      );

      const strategy = await prisma.strategy.create({
        data: {
          title: `${TEST_ID_PREFIX}P13-strat`,
          description: "harness bot strategy",
          monthlyFee: 0,
          minCapital: 100,
          baseCapital: 1000,
          profitShare: 20,
          botStrategyType: "short_strangle",
          botUrl: "http://127.0.0.1:8000",
        },
        select: { id: true },
      });
      strategyId = strategy.id;

      const account = await prisma.exchangeAccount.create({
        data: {
          userId: user.id,
          nickname: `${TEST_ID_PREFIX}acct`,
          exchange: "Delta",
          apiKey: "enc-test-key",
          apiSecret: "enc-test-secret",
        },
        select: { id: true },
      });

      const sub = await prisma.userStrategySubscription.create({
        data: {
          userId: user.id,
          strategyId: strategy.id,
          exchangeAccountId: null, // auto-register gap: keys later, no link
          botSlaveId: "4242",
          multiplier: 5, // $5000 at baseCapital 1000
          isActive: true,
          status: SubscriptionStatus.ACTIVE,
        },
        select: { id: true, multiplier: true },
      });

      // --- 13.8: disconnect when bot deactivation fails → refuse, row remains ---
      installBotBridgeHarnessHooks({
        closeSlaveStructure: async (): Promise<CloseSlaveStructureResult> => ({
          success: false,
          status: 503,
          error: "Bot deactivation mocked failure",
        }),
      });

      const disconnectFail = await disconnectExchangeAccountForUser(
        prisma,
        user.id,
        account.id,
      );
      assert.equal(disconnectFail.ok, false, "disconnect refused when bot fails");
      if (!disconnectFail.ok) {
        assert.assert(
          disconnectFail.status >= 400,
          "disconnect failure returns error status",
        );
      }

      const accountStillThere = await prisma.exchangeAccount.findUnique({
        where: { id: account.id },
      });
      assert.assert(
        accountStillThere != null,
        "ExchangeAccount row still present after refused disconnect",
      );

      resetBotBridgeHarnessHooks();

      // Link account for pause/capital paths (bot ACK succeeds unless overridden)
      await prisma.userStrategySubscription.update({
        where: { id: sub.id },
        data: { exchangeAccountId: account.id },
      });

      // --- 13.9: pause twice → still paused (idempotent PATCH, not toggle) ---
      let botActive = true;
      installBotBridgeHarnessHooks({
        pauseUserOnBot: async (): Promise<BotSlaveResult> => {
          botActive = false;
          return { success: true, botSlaveId: 4242 };
        },
        resumeUserOnBot: async (): Promise<BotSlaveResult> => {
          botActive = true;
          return { success: true, botSlaveId: 4242 };
        },
        updateUserCapitalOnBot: async (): Promise<BotSlaveResult> => ({
          success: false,
          error: "Bot did not acknowledge capital update",
        }),
      });

      const pause1 = await pauseSubscriptionForUser(prisma, {
        userId: user.id,
        strategyId: strategy.id,
      });
      assert.equal(pause1.ok, true, "first pause succeeds");
      assert.equal(botActive, false, "bot marked inactive after first pause");

      const pause2 = await pauseSubscriptionForUser(prisma, {
        userId: user.id,
        strategyId: strategy.id,
      });
      assert.equal(pause2.ok, true, "second pause succeeds (idempotent)");
      assert.equal(botActive, false, "bot still inactive after second pause");

      const subAfterPause = await prisma.userStrategySubscription.findUniqueOrThrow({
        where: { id: sub.id },
      });
      assert.equal(
        subAfterPause.status,
        SubscriptionStatus.PAUSED_BY_USER,
        "subscription remains PAUSED_BY_USER after double pause",
      );
      assert.equal(subAfterPause.isActive, false, "subscription isActive stays false");

      // Resume locally so capital modify finds a managed sub; keep capital mock failing
      await prisma.userStrategySubscription.update({
        where: { id: sub.id },
        data: {
          isActive: true,
          status: SubscriptionStatus.ACTIVE,
        },
      });

      // --- 13.9: capital update bot does not ACK → 502, stored capital unchanged ---
      const beforeMultiplier = sub.multiplier;
      const capitalFail = await modifySubscriptionCapital(prisma, {
        userId: user.id,
        strategyId: strategy.id,
        deployedCapital: 500,
      });
      assert.equal(capitalFail.ok, false, "capital update fails without bot ACK");
      if (!capitalFail.ok) {
        assert.equal(capitalFail.status, 502, "capital failure is 502");
      }

      const subAfterCapital = await prisma.userStrategySubscription.findUniqueOrThrow({
        where: { id: sub.id },
      });
      assert.equal(
        subAfterCapital.multiplier,
        beforeMultiplier,
        "stored multiplier/capital unchanged after failed bot ACK",
      );
    } finally {
      resetBotBridgeHarnessHooks();
      if (strategyId) {
        await prisma.userStrategySubscription.deleteMany({
          where: { strategyId },
        });
        await prisma.strategy.deleteMany({ where: { id: strategyId } });
      }
    }
  },
};
