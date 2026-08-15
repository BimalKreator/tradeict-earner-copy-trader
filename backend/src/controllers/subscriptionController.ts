import type { NextFunction, Request, Response } from "express";
import {
  type PrismaClient,
  SubscriptionStatus,
} from "@prisma/client";
import {
  STRATEGY_PAYMENT_MODE,
} from "../constants/subscription.js";
import { STRATEGY_SELECT_SUBSCRIBE_GATE } from "../prisma/strategySelect.js";
import { validateCouponForFee } from "../services/couponService.js";
import { logUserActivity } from "../services/userActivityService.js";
import {
  resolveEmailRecipientName,
  sendTemplateEmailAsync,
} from "../services/emailService.js";
import {
  distributeRevenueShareCommissions,
  triggerAffiliateCommissionDistribution,
  voidPendingEarnedCommissionsForSourceUser,
} from "../services/affiliateCommissionService.js";
import { computeUserBookedPnlAndRevenueDue } from "../services/dashboardMetricsService.js";
import {
  deployedCapitalFromMultiplier,
  deployedCapitalRangeError,
  parseDeployedCapital,
  parseMultiplierFromBody,
  resolveStrategyBaseCapital,
} from "../utils/subscriptionCapital.js";
import {
  createStrategySubscriptionWithPaymentMode,
  hasBlockingUnpaidInvoicesForStrategy,
  invalidateCopySubscriberCache,
  normalizeFutureHedgeStrategyId,
  parseStrategyPaymentMode,
} from "../services/strategySubscriptionService.js";
import { FUTURE_HEDGE_STRATEGY_TITLE } from "../constants/strategyTitles.js";
import { resolveCanonicalFutureHedgeStrategyId } from "../services/futureHedgeService.js";

export type RecordTradePnlResult = {
  pnlRecordId: string;
  commissionAmount: number;
  commissionsCreated: number;
  commissionsSkipped: number;
};

/** Persists realized trade PnL for billing: per-trade commission (±) on every close. */
export async function recordTradePnl(
  prisma: PrismaClient,
  args: {
    userId: string;
    strategyId: string;
    tradeProfit: number;
    isDummy?: boolean;
    /** When true, await affiliate ledger inserts (admin dummy-trade injector). */
    awaitCommissionDistribution?: boolean;
  },
): Promise<RecordTradePnlResult | null> {
  if (!Number.isFinite(args.tradeProfit)) {
    console.warn("[recordTradePnl] skip: tradeProfit is not finite");
    return null;
  }

  const strategy = await prisma.strategy.findUnique({
    where: { id: args.strategyId },
    select: { profitShare: true },
  });

  if (!strategy) {
    console.warn(
      `[recordTradePnl] skip: strategy not found (${args.strategyId})`,
    );
    return null;
  }

  const booked = await computeUserBookedPnlAndRevenueDue(prisma, args.userId, null);

  let commissionAmount = 0;
  if (strategy.profitShare > 0) {
    commissionAmount = (args.tradeProfit * strategy.profitShare) / 100;
  }

  const row = await prisma.pnLRecord.create({
    data: {
      userId: args.userId,
      strategyId: args.strategyId,
      profitAmount: args.tradeProfit,
      commissionAmount,
      isDummy: args.isDummy === true,
    },
  });

  if (args.isDummy === true) {
    console.log(
      `[recordTradePnl] dummy PnLRecord id=${row.id} user=${args.userId} ` +
        `profit=$${args.tradeProfit.toFixed(2)} appRevenue=$${commissionAmount.toFixed(4)}`,
    );
  }

  if (booked.appRevenue <= 0) {
    await voidPendingEarnedCommissionsForSourceUser(prisma, args.userId);
    return {
      pnlRecordId: row.id,
      commissionAmount,
      commissionsCreated: 0,
      commissionsSkipped: 0,
    };
  }

  if (commissionAmount > 0) {
    const distArgs = {
      sourceUserId: args.userId,
      pnlRecordId: row.id,
      appRevenueBase: commissionAmount,
      profitDate: row.timestamp,
    };
    if (args.awaitCommissionDistribution === true) {
      const dist = await distributeRevenueShareCommissions(prisma, distArgs);
      return {
        pnlRecordId: row.id,
        commissionAmount,
        commissionsCreated: dist.created,
        commissionsSkipped: dist.skipped,
      };
    }
    void triggerAffiliateCommissionDistribution(prisma, distArgs);
  }

  return {
    pnlRecordId: row.id,
    commissionAmount,
    commissionsCreated: 0,
    commissionsSkipped: 0,
  };
}

export function createSubscriptionController(prisma: PrismaClient) {
  const USER_PAUSED_STATUS = SubscriptionStatus.PAUSED_DUE_TO_FUNDS;

  const UNPAID_INVOICE_BLOCK_MESSAGE =
    "Cannot resume or deploy subscription with outstanding unpaid invoices.";

  async function hasUnpaidInvoicesForStrategy(
    userId: string,
    strategyId: string,
  ): Promise<boolean> {
    return hasBlockingUnpaidInvoicesForStrategy(prisma, userId, strategyId);
  }

  async function validateExchangeAccountOwnership(
    userId: string,
    exchangeAccountId: unknown,
  ): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
    if (typeof exchangeAccountId !== "string") {
      return { ok: false, error: "exchangeAccountId must be a string" };
    }
    const trimmed = exchangeAccountId.trim();
    if (!trimmed) {
      return { ok: false, error: "exchangeAccountId cannot be empty" };
    }
    const account = await prisma.exchangeAccount.findFirst({
      where: { id: trimmed, userId },
      select: { id: true },
    });
    if (!account) {
      return {
        ok: false,
        error: "Exchange account not found or does not belong to you",
      };
    }
    return { ok: true, id: trimmed };
  }

  async function resolveStrategyFeeQuote(
    strategyId: string,
    couponCode?: string,
  ): Promise<
    | {
        ok: true;
        originalFeeInr: number;
        discountAmountInr: number;
        finalFeeInr: number;
        discountPercentage: number | null;
        couponId: string | null;
        couponCode: string | null;
      }
    | { ok: false; error: string }
  > {
    const strategy = await prisma.strategy.findUnique({
      where: { id: strategyId },
      select: { monthlyFee: true },
    });
    if (!strategy) return { ok: false, error: "Strategy not found" };

    const originalFeeInr = Math.max(0, strategy.monthlyFee);
    if (!couponCode?.trim()) {
      return {
        ok: true,
        originalFeeInr,
        discountAmountInr: 0,
        finalFeeInr: originalFeeInr,
        discountPercentage: null,
        couponId: null,
        couponCode: null,
      };
    }

    const validated = await validateCouponForFee(
      prisma,
      couponCode,
      originalFeeInr,
    );
    if (!validated.ok) return validated;

    return {
      ok: true,
      originalFeeInr: validated.originalFeeInr,
      discountAmountInr: validated.discountAmountInr,
      finalFeeInr: validated.finalFeeInr,
      discountPercentage: validated.discountPercentage,
      couponId: validated.coupon.id,
      couponCode: validated.coupon.code,
    };
  }

  async function validateCoupon(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      const userId = req.userId;
      if (!userId) {
        res.status(401).json({ error: "Unauthorized" });
        return;
      }

      const body = req.body as { strategyId?: unknown; couponCode?: unknown };
      const strategyId =
        typeof body.strategyId === "string" ? body.strategyId.trim() : "";
      const couponCode =
        typeof body.couponCode === "string" ? body.couponCode : "";

      if (!strategyId) {
        res.status(400).json({ error: "strategyId is required" });
        return;
      }
      if (!couponCode.trim()) {
        res.status(400).json({ error: "couponCode is required" });
        return;
      }

      const quote = await resolveStrategyFeeQuote(strategyId, couponCode);
      if (!quote.ok) {
        res.status(400).json({ error: quote.error });
        return;
      }

      res.json({
        valid: true,
        strategyId,
        couponCode: quote.couponCode,
        originalFeeInr: quote.originalFeeInr,
        discountAmountInr: quote.discountAmountInr,
        finalFeeInr: quote.finalFeeInr,
        discountPercentage: quote.discountPercentage,
      });
    } catch (err) {
      next(err);
    }
  }

  async function getCheckoutQuote(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      const userId = req.userId;
      if (!userId) {
        res.status(401).json({ error: "Unauthorized" });
        return;
      }

      const body = req.body as { strategyId?: unknown; couponCode?: unknown };
      const strategyId =
        typeof body.strategyId === "string" ? body.strategyId.trim() : "";
      const couponCode =
        typeof body.couponCode === "string" ? body.couponCode : undefined;

      if (!strategyId) {
        res.status(400).json({ error: "strategyId is required" });
        return;
      }

      const quote = await resolveStrategyFeeQuote(strategyId, couponCode);
      if (!quote.ok) {
        res.status(400).json({ error: quote.error });
        return;
      }

      res.json(quote);
    } catch (err) {
      next(err);
    }
  }

  async function subscribe(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      const userId = req.userId;
      if (!userId) {
        res.status(401).json({ error: "Unauthorized" });
        return;
      }

      const body = req.body as {
        strategyId?: unknown;
        couponCode?: unknown;
        paymentMode?: unknown;
      };

      const rawStrategyId =
        typeof body.strategyId === "string" ? body.strategyId.trim() : "";
      const couponCode =
        typeof body.couponCode === "string" ? body.couponCode : undefined;
      const paymentMode =
        parseStrategyPaymentMode(body.paymentMode) ??
        STRATEGY_PAYMENT_MODE.PAY_NOW;

      if (!rawStrategyId) {
        res.status(400).json({ error: "strategyId is required" });
        return;
      }

      const strategyId = await normalizeFutureHedgeStrategyId(
        prisma,
        rawStrategyId,
      );

      const strategy = await prisma.strategy.findUnique({
        where: { id: strategyId },
        select: { ...STRATEGY_SELECT_SUBSCRIBE_GATE, title: true },
      });
      if (!strategy) {
        res.status(404).json({ error: "Strategy not found" });
        return;
      }

      const feeQuote = await resolveStrategyFeeQuote(strategyId, couponCode);
      if (!feeQuote.ok) {
        res.status(400).json({ error: feeQuote.error });
        return;
      }

      if (feeQuote.finalFeeInr > 0 && paymentMode === STRATEGY_PAYMENT_MODE.PAY_NOW) {
        res.status(402).json({
          error:
            "This strategy requires payment. Use checkout (Razorpay) or choose pay-later.",
          requiresPayment: true,
          paymentMode: STRATEGY_PAYMENT_MODE.PAY_NOW,
          originalFeeInr: feeQuote.originalFeeInr,
          finalFeeInr: feeQuote.finalFeeInr,
        });
        return;
      }

      const existing = await prisma.userStrategySubscription.findFirst({
        where: {
          userId,
          strategyId,
          status: {
            in: [SubscriptionStatus.ACTIVE, USER_PAUSED_STATUS],
          },
        },
      });

      if (existing) {
        res.status(409).json({
          error: "You already have this strategy in My Strategies",
        });
        return;
      }

      let subscription;
      let strategyFeeInvoiceId: string | null = null;

      if (feeQuote.finalFeeInr > 0 && paymentMode === STRATEGY_PAYMENT_MODE.PAY_LATER) {
        const created = await createStrategySubscriptionWithPaymentMode(prisma, {
          userId,
          strategyId,
          paymentMode: STRATEGY_PAYMENT_MODE.PAY_LATER,
          finalFeeInr: feeQuote.finalFeeInr,
          couponId: feeQuote.couponId,
        });
        subscription = created.subscription;
        strategyFeeInvoiceId = created.strategyFeeInvoiceId;
      } else {
        subscription = await prisma.userStrategySubscription.create({
          data: {
            userId,
            strategyId,
            multiplier: 1,
            isActive: false,
            status: SubscriptionStatus.ACTIVE,
            isStrategyFeePaid: true,
          },
        });
        invalidateCopySubscriberCache();
      }

      console.log(
        `[subscription] Strategy added id=${subscription.id} userId=${userId} strategyId=${strategyId} paymentMode=${paymentMode}`,
      );

      // Bot bridge: register user on Delta Bot if this is a bot-type strategy
      try {
        const strategy = await prisma.strategy.findUnique({
          where: { id: strategyId },
          select: {
            botStrategyType: true,
            botUrl: true,
            baseCapital: true,
          },
        });

        if (strategy?.botStrategyType && strategy?.botUrl) {
          // Get user's exchange account API keys
          const subscription = await prisma.userStrategySubscription.findFirst({
            where: { userId, strategyId },
            include: { exchangeAccount: true },
          });

          if (subscription?.exchangeAccount) {
            const { decryptDeltaSecretOrPlain } = await import(
              '../utils/encryption.js'
            );
            const apiKey = decryptDeltaSecretOrPlain(
              subscription.exchangeAccount.apiKey,
            );
            const apiSecret = decryptDeltaSecretOrPlain(
              subscription.exchangeAccount.apiSecret,
            );

            // Calculate deployed capital
            const deployedCapital =
              subscription.multiplier * (strategy.baseCapital ?? 300);

            const { onSubscriptionCreated } = await import(
              '../services/botBridgeService.js'
            );
            const botSlaveId = await onSubscriptionCreated({
              userId,
              strategyId,
              subscriptionId: subscription.id,
              apiKey,
              apiSecret,
              userAllocatedCapitalUsd: deployedCapital,
            });

            if (botSlaveId != null) {
              await prisma.$executeRaw`
                UPDATE "UserSubscription"
                SET "botSlaveId" = ${String(botSlaveId)}
                WHERE id = ${subscription.id}
              `;
              console.log(
                `[Subscription] botSlaveId saved: ${subscription.id} → ${botSlaveId}`,
              );
              console.log(
                `[Subscription] Bot slave registered: userId=${userId} botSlaveId=${botSlaveId}`,
              );
            }
          }
        }
      } catch (botErr) {
        // Non-fatal: subscription already created, bot registration failed
        console.error('[Subscription] Bot bridge error (non-fatal):', botErr);
      }

      void logUserActivity(prisma, {
        userId,
        kind: "SUBSCRIPTION_CREATED",
        message:
          paymentMode === STRATEGY_PAYMENT_MODE.PAY_LATER
            ? `Subscribed with pay-later (${strategy.title})`
            : `Added strategy to My Strategies (inactive)`,
      });

      const subscriber = await prisma.user.findUnique({
        where: { id: userId },
        select: { email: true, name: true },
      });
      if (subscriber?.email) {
        sendTemplateEmailAsync(subscriber.email, "member_registration", {
          userName: resolveEmailRecipientName(subscriber.name, subscriber.email),
          strategyName: strategy.title,
        });
      }

      res.status(201).json({
        ...subscription,
        paymentMode,
        strategyFeeInvoiceId,
      });
    } catch (err) {
      next(err);
    }
  }

  const strategySelectPublic = {
    id: true,
    title: true,
    description: true,
    monthlyFee: true,
    minCapital: true,
    baseCapital: true,
    profitShare: true,
    slippage: true,
    performanceMetrics: true,
    syncActiveTrades: true,
    botStrategyType: true,
    createdAt: true,
  } as const;

  /** Strategies available in the marketplace (all rows; schema has no archived flag). */
  async function listStrategies(
    _req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      const userId = _req.userId;
      if (!userId) {
        res.status(401).json({ error: "Unauthorized" });
        return;
      }
      const strategies = await prisma.strategy.findMany({
        orderBy: { createdAt: "desc" },
        select: strategySelectPublic,
      });
      const canonicalFutureHedgeId =
        await resolveCanonicalFutureHedgeStrategyId(prisma);
      const deduped = strategies.filter(
        (s) =>
          s.title !== FUTURE_HEDGE_STRATEGY_TITLE ||
          s.id === canonicalFutureHedgeId,
      );
      res.json(deduped);
    } catch (err) {
      next(err);
    }
  }

  /** All subscription rows for the current user (any status), with strategy + exchange account. */
  async function listMySubscriptions(
    _req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      const userId = _req.userId;
      if (!userId) {
        res.status(401).json({ error: "Unauthorized" });
        return;
      }
      const rows = await prisma.userStrategySubscription.findMany({
        where: { userId },
        orderBy: { joinedDate: "desc" },
        include: {
          strategy: { select: strategySelectPublic },
          exchangeAccount: {
            select: { id: true, nickname: true, exchange: true },
          },
        },
      });
      res.json({ subscriptions: rows });
    } catch (err) {
      next(err);
    }
  }

  async function getStrategy(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      const userId = req.userId;
      if (!userId) {
        res.status(401).json({ error: "Unauthorized" });
        return;
      }
      const rawId = req.params.id;
      const id = Array.isArray(rawId) ? rawId[0] : rawId;
      if (typeof id !== "string" || !id.trim()) {
        res.status(400).json({ error: "id is required" });
        return;
      }
      const strategy = await prisma.strategy.findUnique({
        where: { id: id.trim() },
        select: strategySelectPublic,
      });
      if (!strategy) {
        res.status(404).json({ error: "Strategy not found" });
        return;
      }
      res.json(strategy);
    } catch (err) {
      next(err);
    }
  }

  async function unsubscribe(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      const userId = req.userId;
      if (!userId) {
        res.status(401).json({ error: "Unauthorized" });
        return;
      }

      const raw = req.params.strategyId;
      const rawStrategyId = Array.isArray(raw) ? raw[0] : raw;
      if (typeof rawStrategyId !== "string" || !rawStrategyId.trim()) {
        res.status(400).json({ error: "strategyId is required" });
        return;
      }
      const strategyId = await normalizeFutureHedgeStrategyId(
        prisma,
        rawStrategyId.trim(),
      );

      const sub = await prisma.userStrategySubscription.findFirst({
        where: {
          userId,
          strategyId,
          status: {
            in: [SubscriptionStatus.ACTIVE, USER_PAUSED_STATUS],
          },
        },
        select: { id: true },
      });

      if (!sub) {
        res.status(404).json({ error: "Subscription not found" });
        return;
      }

      await prisma.userStrategySubscription.delete({
        where: { id: sub.id },
      });

      void logUserActivity(prisma, {
        userId,
        kind: "SUBSCRIPTION_CANCELLED",
        message: `Unsubscribed from strategy ${strategyId.trim()}`,
      });

      res.status(204).send();
    } catch (err) {
      next(err);
    }
  }

  async function deploy(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      const userId = req.userId;
      if (!userId) return void res.status(401).json({ error: "Unauthorized" });
      const rawStrategyId = String(req.params.strategyId ?? "").trim();
      if (!rawStrategyId) {
        return void res.status(400).json({ error: "strategyId is required" });
      }
      const strategyId = await normalizeFutureHedgeStrategyId(
        prisma,
        rawStrategyId,
      );

      const body = req.body as {
        deployedCapital?: unknown;
        multiplier?: unknown;
        exchangeAccountId?: unknown;
      };

      const sub = await prisma.userStrategySubscription.findFirst({
        where: { userId, strategyId, status: { in: [SubscriptionStatus.ACTIVE, USER_PAUSED_STATUS] } },
        include: {
          strategy: {
            select: {
              ...STRATEGY_SELECT_SUBSCRIBE_GATE,
              baseCapital: true,
              minCapital: true,
              title: true,
            },
          },
        },
      });
      if (!sub) return void res.status(404).json({ error: "Subscription not found" });

      const multiplier = parseMultiplierFromBody(body, resolveStrategyBaseCapital(sub.strategy));
      if (multiplier == null) {
        return void res.status(400).json({
          error: deployedCapitalRangeError(resolveStrategyBaseCapital(sub.strategy)),
        });
      }
      const ex = await validateExchangeAccountOwnership(userId, body.exchangeAccountId);
      if (!ex.ok) return void res.status(400).json({ error: ex.error });

      if (await hasUnpaidInvoicesForStrategy(userId, strategyId)) {
        return void res.status(403).json({ error: UNPAID_INVOICE_BLOCK_MESSAGE });
      }

      const updated = await prisma.userStrategySubscription.update({
        where: { id: sub.id },
        data: {
          multiplier,
          exchangeAccountId: ex.id,
          isActive: true,
          status: SubscriptionStatus.ACTIVE,
          syncStatus: "PENDING",
          syncError: null,
        },
        include: {
          strategy: { select: strategySelectPublic },
          exchangeAccount: { select: { id: true, nickname: true, exchange: true } },
        },
      });

      if (sub.strategy.syncActiveTrades) {
        void import("../services/tradeEngine.js")
          .then(({ lateJoinMirrorOpenPositionsForSubscriber }) =>
            lateJoinMirrorOpenPositionsForSubscriber(prisma, { strategyId, userId }),
          )
          .catch((err) => {
            const msg = err instanceof Error ? err.message : String(err);
            console.error(`[subscription] deploy late-join failed strategyId=${strategyId} userId=${userId}:`, msg);
          });
      }

      const subscriber = await prisma.user.findUnique({
        where: { id: userId },
        select: { email: true, name: true },
      });
      if (subscriber?.email) {
        sendTemplateEmailAsync(subscriber.email, "approval_notification", {
          userName: resolveEmailRecipientName(subscriber.name, subscriber.email),
          approvalType: "subscription",
          strategyName: updated.strategy.title,
        });
      }

      invalidateCopySubscriberCache();
      res.json({ subscription: updated });
    } catch (err) {
      next(err);
    }
  }

  async function modify(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      const userId = req.userId;
      if (!userId) return void res.status(401).json({ error: "Unauthorized" });
      const rawStrategyId = String(req.params.strategyId ?? "").trim();
      if (!rawStrategyId) return void res.status(400).json({ error: "strategyId is required" });
      const strategyId = await normalizeFutureHedgeStrategyId(
        prisma,
        rawStrategyId,
      );
      const body = req.body as { deployedCapital?: unknown; multiplier?: unknown };
      const sub = await prisma.userStrategySubscription.findFirst({
        where: { userId, strategyId, status: { in: [SubscriptionStatus.ACTIVE, USER_PAUSED_STATUS] } },
        select: {
          id: true,
          botSlaveId: true,
          strategy: {
            select: {
              baseCapital: true,
              minCapital: true,
              botStrategyType: true,
            },
          },
        },
      });
      if (!sub) return void res.status(404).json({ error: "Subscription not found" });

      const baseCapital = resolveStrategyBaseCapital(sub.strategy);
      const multiplier = parseMultiplierFromBody(body, baseCapital);
      if (multiplier == null) {
        return void res.status(400).json({
          error: deployedCapitalRangeError(baseCapital),
        });
      }

      const newCapitalUsd =
        parseDeployedCapital(body.deployedCapital) ??
        deployedCapitalFromMultiplier(multiplier, baseCapital);

      const updated = await prisma.userStrategySubscription.update({
        where: { id: sub.id },
        data: { multiplier },
        include: {
          strategy: { select: strategySelectPublic },
          exchangeAccount: { select: { id: true, nickname: true, exchange: true } },
        },
      });
      invalidateCopySubscriberCache();

      // Update bot slave capital if this is a bot-type strategy
      if (
        sub.botSlaveId &&
        typeof sub.strategy.botStrategyType === "string" &&
        sub.strategy.botStrategyType.trim()
      ) {
        const botSlaveIdNum = Number.parseInt(sub.botSlaveId, 10);
        if (Number.isFinite(botSlaveIdNum)) {
          try {
            const { updateUserCapitalOnBot } = await import(
              "../services/botBridgeService.js"
            );
            await updateUserCapitalOnBot({
              botSlaveId: botSlaveIdNum,
              userAllocatedCapitalUsd: newCapitalUsd,
            });
            console.log(
              "[Capital] Updated bot slave capital:",
              botSlaveIdNum,
              newCapitalUsd,
            );
          } catch (botErr) {
            console.error(
              "[Capital] Bot slave capital update failed (non-fatal):",
              botErr,
            );
          }
        }
      }

      res.json({ subscription: updated });
    } catch (err) {
      next(err);
    }
  }

  async function pause(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const userId = req.userId;
      if (!userId) return void res.status(401).json({ error: "Unauthorized" });
      const rawStrategyId = String(req.params.strategyId ?? "").trim();
      if (!rawStrategyId) return void res.status(400).json({ error: "strategyId is required" });
      const strategyId = await normalizeFutureHedgeStrategyId(
        prisma,
        rawStrategyId,
      );
      const sub = await prisma.userStrategySubscription.findFirst({
        where: { userId, strategyId, status: SubscriptionStatus.ACTIVE },
        select: { id: true },
      });
      if (!sub) return void res.status(404).json({ error: "Active subscription not found" });
      const updated = await prisma.userStrategySubscription.update({
        where: { id: sub.id },
        data: { isActive: false, status: USER_PAUSED_STATUS },
        include: {
          strategy: { select: strategySelectPublic },
          exchangeAccount: { select: { id: true, nickname: true, exchange: true } },
        },
      });
      res.json({ subscription: updated });
    } catch (err) {
      next(err);
    }
  }

  async function resume(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const userId = req.userId;
      if (!userId) return void res.status(401).json({ error: "Unauthorized" });
      const rawStrategyId = String(req.params.strategyId ?? "").trim();
      if (!rawStrategyId) return void res.status(400).json({ error: "strategyId is required" });
      const strategyId = await normalizeFutureHedgeStrategyId(
        prisma,
        rawStrategyId,
      );
      const sub = await prisma.userStrategySubscription.findFirst({
        where: { userId, strategyId, status: USER_PAUSED_STATUS },
        include: { strategy: { select: STRATEGY_SELECT_SUBSCRIBE_GATE } },
      });
      if (!sub) return void res.status(404).json({ error: "Paused subscription not found" });
      if (!sub.exchangeAccountId) {
        return void res.status(400).json({ error: "Deploy this strategy first (missing exchange account)." });
      }

      if (await hasUnpaidInvoicesForStrategy(userId, strategyId)) {
        return void res.status(403).json({ error: UNPAID_INVOICE_BLOCK_MESSAGE });
      }

      const updated = await prisma.userStrategySubscription.update({
        where: { id: sub.id },
        data: {
          isActive: true,
          status: SubscriptionStatus.ACTIVE,
          syncStatus: "PENDING",
          syncError: null,
        },
        include: {
          strategy: { select: strategySelectPublic },
          exchangeAccount: { select: { id: true, nickname: true, exchange: true } },
        },
      });

      if (sub.strategy.syncActiveTrades) {
        void import("../services/tradeEngine.js")
          .then(({ lateJoinMirrorOpenPositionsForSubscriber }) =>
            lateJoinMirrorOpenPositionsForSubscriber(prisma, { strategyId, userId }),
          )
          .catch((err) => {
            const msg = err instanceof Error ? err.message : String(err);
            console.error(`[subscription] resume late-join failed strategyId=${strategyId} userId=${userId}:`, msg);
          });
      }

      res.json({ subscription: updated });
    } catch (err) {
      next(err);
    }
  }

  return {
    subscribe,
    unsubscribe,
    remove: unsubscribe,
    deploy,
    modify,
    pause,
    resume,
    listStrategies,
    listMySubscriptions,
    getStrategy,
    validateCoupon,
    getCheckoutQuote,
  };
}
