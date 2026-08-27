import type { NextFunction, Request, Response } from "express";
import {
  Prisma,
  type PrismaClient,
  SubscriptionStatus,
} from "@prisma/client";
import {
  STRATEGY_PAYMENT_MODE,
  MANAGED_SUBSCRIPTION_STATUSES,
} from "../constants/subscription.js";
import { STRATEGY_SELECT_SUBSCRIBE_GATE } from "../prisma/strategySelect.js";
import { validateCouponForFee } from "../services/couponService.js";
import { logUserActivity } from "../services/userActivityService.js";
import {
  resolveEmailRecipientName,
  sendTemplateEmailAsync,
} from "../services/emailService.js";
import { voidPendingEarnedCommissionsForSourceUser } from "../services/affiliateCommissionService.js";
import { computeUserBookedPnlAndRevenueDue } from "../services/dashboardMetricsService.js";
import {
  deployedCapitalFromMultiplier,
  deployedCapitalRangeError,
  parseDeployedCapital,
  parseMultiplierFromBody,
  resolveStrategyBaseCapital,
} from "../utils/subscriptionCapital.js";
import { FUTURE_HEDGE_STRATEGY_TITLE } from "../constants/strategyTitles.js";
import { resolveCanonicalFutureHedgeStrategyId } from "../services/futureHedgeService.js";
import {
  hasBlockingUnpaidInvoicesForStrategy,
  invalidateCopySubscriberCache,
  normalizeFutureHedgeStrategyId,
  parseStrategyPaymentMode,
  resolveStrategyFeeQuote,
  subscribeUserToStrategy,
} from "../services/strategySubscriptionService.js";

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
    return {
      pnlRecordId: row.id,
      commissionAmount,
      commissionsCreated: 0,
      commissionsSkipped: 0,
    };
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

  return {
    pnlRecordId: row.id,
    commissionAmount,
    commissionsCreated: 0,
    commissionsSkipped: 0,
  };
}

export function createSubscriptionController(prisma: PrismaClient) {
  const VOLUNTARY_PAUSED_STATUS = SubscriptionStatus.PAUSED_BY_USER;
  const MANAGED_SUBSCRIPTION_STATUSES = [
    SubscriptionStatus.ACTIVE,
    SubscriptionStatus.PAUSED_BY_USER,
    SubscriptionStatus.PAUSED_DUE_TO_FUNDS,
  ] as const;

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

  async function feeQuoteForStrategy(strategyId: string, couponCode?: string) {
    return resolveStrategyFeeQuote(prisma, strategyId, couponCode);
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

      const quote = await feeQuoteForStrategy(strategyId, couponCode);
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

      const quote = await feeQuoteForStrategy(strategyId, couponCode);
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

      const result = await subscribeUserToStrategy(prisma, {
        userId,
        rawStrategyId,
        paymentMode,
        ...(couponCode !== undefined ? { couponCode } : {}),
      });

      if (!result.ok) {
        if (result.requiresPayment) {
          res.status(result.status).json({
            error: result.error,
            requiresPayment: true,
            paymentMode: result.paymentMode,
            originalFeeInr: result.originalFeeInr,
            finalFeeInr: result.finalFeeInr,
          });
          return;
        }
        res.status(result.status).json({ error: result.error });
        return;
      }

      console.log(
        `[subscription] Strategy added id=${result.subscription.id} userId=${userId} strategyId=${result.subscription.strategyId} paymentMode=${result.paymentMode}`,
      );

      res.status(201).json({
        ...result.subscription,
        paymentMode: result.paymentMode,
        strategyFeeInvoiceId: result.strategyFeeInvoiceId,
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
            in: [...MANAGED_SUBSCRIPTION_STATUSES],
          },
        },
        select: {
          id: true,
          userId: true,
          strategyId: true,
          botSlaveId: true,
          strategy: { select: { botStrategyType: true } },
        },
      });

      if (!sub) {
        res.status(404).json({ error: "Subscription not found" });
        return;
      }

      const {
        closeAndBillForBotSubscription,
        mapCancellationBillingError,
      } = await import("../services/cancellationBillingService.js");

      try {
        const billingResult = await closeAndBillForBotSubscription(
          prisma,
          sub,
          "SUBSCRIPTION_CANCELLED",
        );

        if (!billingResult) {
          await prisma.userStrategySubscription.update({
            where: { id: sub.id },
            data: {
              isActive: false,
              status: SubscriptionStatus.CANCELLED,
            },
          });
        }

        void logUserActivity(prisma, {
          userId,
          kind: "SUBSCRIPTION_CANCELLED",
          message: `Unsubscribed from strategy ${strategyId.trim()}`,
        });

        res.json({
          ok: true,
          finalInvoiceSchedule: billingResult?.finalInvoiceSchedule ?? null,
        });
      } catch (billingErr) {
        const mapped = mapCancellationBillingError(billingErr);
        if (mapped) {
          res.status(mapped.status).json(mapped.body);
          return;
        }
        throw billingErr;
      }
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
        where: { userId, strategyId, status: { in: [...MANAGED_SUBSCRIPTION_STATUSES] } },
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
      const { modifySubscriptionCapital } = await import(
        "../services/subscriptionLifecycleService.js"
      );
      const result = await modifySubscriptionCapital(prisma, {
        userId,
        strategyId,
        deployedCapital: body.deployedCapital,
        multiplier: body.multiplier,
      });
      if (!result.ok) {
        return void res.status(result.status).json({ error: result.error });
      }
      invalidateCopySubscriberCache();
      const subscription = result.subscription as {
        isActive?: boolean;
      };
      const notice =
        subscription.isActive === false
          ? "Saved. Deploy this strategy to start copy trading."
          : undefined;
      res.json({
        subscription: result.subscription,
        ...(notice ? { notice, message: notice } : {}),
      });
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
      const { pauseSubscriptionForUser } = await import(
        "../services/subscriptionLifecycleService.js"
      );
      const result = await pauseSubscriptionForUser(prisma, { userId, strategyId });
      if (!result.ok) {
        return void res.status(result.status).json({ error: result.error });
      }
      res.json({ subscription: result.subscription });
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
        where: { userId, strategyId, status: VOLUNTARY_PAUSED_STATUS },
        include: { strategy: { select: STRATEGY_SELECT_SUBSCRIBE_GATE } },
      });
      if (!sub) return void res.status(404).json({ error: "Paused subscription not found" });
      if (!sub.exchangeAccountId) {
        return void res.status(400).json({ error: "Deploy this strategy first (missing exchange account)." });
      }

      if (await hasUnpaidInvoicesForStrategy(userId, strategyId)) {
        return void res.status(403).json({ error: UNPAID_INVOICE_BLOCK_MESSAGE });
      }

      const { resumeSubscriptionForUser } = await import(
        "../services/subscriptionLifecycleService.js"
      );
      const result = await resumeSubscriptionForUser(prisma, { userId, strategyId });
      if (!result.ok) {
        return void res.status(result.status).json({ error: result.error });
      }

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

      res.json({ subscription: result.subscription });
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
