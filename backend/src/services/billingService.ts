import type { PrismaClient } from "@prisma/client";
import {
  InvoiceStatus,
  Prisma,
  SubscriptionStatus,
  TradeStatus,
} from "@prisma/client";
import cron from "node-cron";

/** Days a generated invoice has before it goes OVERDUE and pauses the subscription. */
const INVOICE_DUE_DAYS = 5;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** Internal label for wallet ledger rows produced by the auto-deduct flow. */
const WALLET_TXN_TYPE_INVOICE_PAYMENT = "INVOICE_PAYMENT";
/** WalletTransaction.status uses plain strings; settled rows are tagged COMPLETED. */
const WALLET_TXN_STATUS_COMPLETED = "COMPLETED";

/**
 * UTC timestamp marking the first instant of the calendar month containing `ref`.
 * Used to bound the rolling High-Water Mark monthly billing window.
 */
function startOfUtcMonth(ref: Date): Date {
  return new Date(Date.UTC(ref.getUTCFullYear(), ref.getUTCMonth(), 1));
}

/**
 * Half-open `[start, end)` range covering the calendar month identified by
 * `month` (1–12) / `year`. `end` is the first instant of the next month.
 */
function getMonthRange(
  month: number,
  year: number,
): { start: Date; end: Date } {
  const start = new Date(Date.UTC(year, month - 1, 1));
  const end = new Date(Date.UTC(year, month, 1));
  return { start, end };
}

/**
 * Returns the calendar month immediately preceding `ref` (1-indexed month).
 * Handles January → previous-year December rollover.
 */
function previousMonth(ref: Date): { month: number; year: number } {
  const m0 = ref.getUTCMonth();
  const y = ref.getUTCFullYear();
  if (m0 === 0) return { month: 12, year: y - 1 };
  return { month: m0, year: y };
}

/**
 * Realized USD PnL for a closed trade. Prefers the explicit `tradePnl` column
 * the trade engine writes; falls back to the legacy `pnl` field for trades
 * closed before the engine started populating `tradePnl`.
 */
function realizedTradePnl(trade: {
  tradePnl: number;
  pnl: number | null;
}): number {
  if (Number.isFinite(trade.tradePnl) && trade.tradePnl !== 0) {
    return trade.tradePnl;
  }
  return Number.isFinite(trade.pnl ?? NaN) ? (trade.pnl as number) : 0;
}

export interface CurrentMonthBilling {
  cumulativePnl: number;
  estimatedDue: number;
}

/**
 * Live month-to-date High-Water Mark snapshot for a single (user, strategy).
 *
 * - `cumulativePnl` = Σ realized PnL of CLOSED trades from the 1st of the
 *   current UTC month up to "now".
 * - `estimatedDue`  = `cumulativePnl * profitShare/100` when positive,
 *   otherwise `0`. Negative cumulative PnL never produces a fee.
 */
export async function getCurrentMonthBilling(
  prisma: PrismaClient,
  userId: string,
  strategyId: string,
): Promise<CurrentMonthBilling> {
  const strategy = await prisma.strategy.findUnique({
    where: { id: strategyId },
    select: { profitShare: true },
  });
  if (!strategy) {
    throw new Error(`Strategy not found: ${strategyId}`);
  }

  const now = new Date();
  const monthStart = startOfUtcMonth(now);

  const trades = await prisma.trade.findMany({
    where: {
      userId,
      strategyId,
      status: TradeStatus.CLOSED,
      createdAt: { gte: monthStart, lte: now },
    },
    select: { tradePnl: true, pnl: true },
  });

  const cumulativePnl = trades.reduce(
    (sum, t) => sum + realizedTradePnl(t),
    0,
  );

  const estimatedDue =
    cumulativePnl > 0 ? cumulativePnl * (strategy.profitShare / 100) : 0;

  return { cumulativePnl, estimatedDue };
}

export interface CurrentMonthBillingByStrategy {
  strategyId: string;
  strategyTitle: string;
  profitShare: number;
  cumulativePnl: number;
  estimatedDue: number;
}

export interface CurrentMonthBillingForUser {
  totals: {
    cumulativePnl: number;
    estimatedDue: number;
  };
  byStrategy: CurrentMonthBillingByStrategy[];
}

/**
 * Aggregated live month-to-date billing snapshot across **all** of the user's
 * ACTIVE subscriptions.
 *
 * `totals.cumulativePnl` is the sum of per-strategy cumulative PnL (so a
 * losing strategy can offset a winning one in the headline number), but
 * `totals.estimatedDue` is computed strategy-by-strategy and only positive
 * cumulative PnL contributes — this matches the cron's behaviour and means
 * a user whose net is negative across two strategies still owes a fee on
 * any strategy that's individually profitable.
 */
export async function getCurrentMonthBillingForUser(
  prisma: PrismaClient,
  userId: string,
): Promise<CurrentMonthBillingForUser> {
  const subs = await prisma.userSubscription.findMany({
    where: { userId, status: SubscriptionStatus.ACTIVE },
    select: {
      strategyId: true,
      strategy: { select: { title: true, profitShare: true } },
    },
  });

  const now = new Date();
  const monthStart = startOfUtcMonth(now);

  const byStrategy: CurrentMonthBillingByStrategy[] = [];
  let totalCumulative = 0;
  let totalDue = 0;

  for (const sub of subs) {
    const trades = await prisma.trade.findMany({
      where: {
        userId,
        strategyId: sub.strategyId,
        status: TradeStatus.CLOSED,
        createdAt: { gte: monthStart, lte: now },
      },
      select: { tradePnl: true, pnl: true },
    });

    const cumulativePnl = trades.reduce(
      (s, t) => s + realizedTradePnl(t),
      0,
    );
    const estimatedDue =
      cumulativePnl > 0
        ? cumulativePnl * (sub.strategy.profitShare / 100)
        : 0;

    byStrategy.push({
      strategyId: sub.strategyId,
      strategyTitle: sub.strategy.title,
      profitShare: sub.strategy.profitShare,
      cumulativePnl,
      estimatedDue,
    });

    totalCumulative += cumulativePnl;
    totalDue += estimatedDue;
  }

  return {
    totals: {
      cumulativePnl: totalCumulative,
      estimatedDue: totalDue,
    },
    byStrategy,
  };
}

export interface PlatformRevenueStats {
  /** Σ realized PnL across every CLOSED trade in the current UTC month, all users. */
  totalPlatformPnl: number;
  /**
   * What we'd invoice today if the month closed right now: Σ over every
   * ACTIVE (user, strategy) of `max(0, cumulativePnl) * profitShare/100`.
   */
  expectedRevenue: number;
}

/**
 * Platform-wide month-to-date revenue snapshot, used by the admin
 * revenue dashboard. One trade fetch + one subscription fetch — the
 * per-(user, strategy) aggregation runs in-memory.
 */
export async function getPlatformRevenueStats(
  prisma: PrismaClient,
): Promise<PlatformRevenueStats> {
  const now = new Date();
  const monthStart = startOfUtcMonth(now);

  const trades = await prisma.trade.findMany({
    where: {
      status: TradeStatus.CLOSED,
      createdAt: { gte: monthStart, lte: now },
    },
    select: { userId: true, strategyId: true, tradePnl: true, pnl: true },
  });

  let totalPlatformPnl = 0;
  const perPair = new Map<string, number>();
  for (const t of trades) {
    const realized = realizedTradePnl(t);
    totalPlatformPnl += realized;
    const key = `${t.userId}::${t.strategyId}`;
    perPair.set(key, (perPair.get(key) ?? 0) + realized);
  }

  const subs = await prisma.userSubscription.findMany({
    where: { status: SubscriptionStatus.ACTIVE },
    select: {
      userId: true,
      strategyId: true,
      strategy: { select: { profitShare: true } },
    },
  });

  let expectedRevenue = 0;
  for (const sub of subs) {
    const key = `${sub.userId}::${sub.strategyId}`;
    const cum = perPair.get(key) ?? 0;
    if (cum > 0) {
      expectedRevenue += cum * (sub.strategy.profitShare / 100);
    }
  }

  return { totalPlatformPnl, expectedRevenue };
}

export interface GenerateMonthlyInvoicesResult {
  month: number;
  year: number;
  /** (user, strategy) pairs that had positive PnL → invoice created. */
  invoicesCreated: number;
  /** Of those, how many were paid in full immediately by wallet auto-deduct. */
  invoicesAutoPaid: number;
  /** (user, strategy) pairs evaluated but skipped (already invoiced or no positive PnL). */
  skipped: number;
}

/**
 * Monthly High-Water Mark invoice generator.
 *
 * For every ACTIVE subscription, sums realized PnL on CLOSED trades that fell
 * inside the target calendar month. When `cumulativePnl > 0`, creates an
 * `Invoice { status: PENDING, dueDate: now + 5 days, amountDue: cumPnl * profitShare/100 }`,
 * then attempts wallet auto-deduct in the same transaction.
 *
 * If `opts.month/year` is omitted the previous calendar month (UTC) is used —
 * matching the cron that runs at 00:05 UTC on the 1st of each month. The
 * month/year overrides exist for the admin "trigger-billing-cron" test
 * endpoint so QA can target the current month against seeded trades.
 *
 * `opts.scope` lets QA / integration tests narrow the run to a specific set
 * of users or subscriptions (production cron always passes `undefined`,
 * which processes every ACTIVE subscription).
 *
 * Idempotent: relies on the `@@unique([userId, strategyId, month, year])`
 * constraint on `Invoice` — a duplicate run is a no-op for already-billed
 * (user, strategy, month) tuples.
 */
export async function generateMonthlyInvoices(
  prisma: PrismaClient,
  opts: {
    month?: number;
    year?: number;
    reference?: Date;
    scope?: { userIds?: string[]; subscriptionIds?: string[] };
  } = {},
): Promise<GenerateMonthlyInvoicesResult> {
  const ref = opts.reference ?? new Date();
  const target =
    opts.month !== undefined && opts.year !== undefined
      ? { month: opts.month, year: opts.year }
      : previousMonth(ref);

  const { month, year } = target;
  if (
    !Number.isInteger(month) ||
    month < 1 ||
    month > 12 ||
    !Number.isInteger(year)
  ) {
    throw new Error(
      `generateMonthlyInvoices: invalid target month=${month} year=${year}`,
    );
  }

  const { start, end } = getMonthRange(month, year);

  const subscriptionWhere: Prisma.UserSubscriptionWhereInput = {
    status: SubscriptionStatus.ACTIVE,
  };
  if (opts.scope?.userIds && opts.scope.userIds.length > 0) {
    subscriptionWhere.userId = { in: opts.scope.userIds };
  }
  if (opts.scope?.subscriptionIds && opts.scope.subscriptionIds.length > 0) {
    subscriptionWhere.id = { in: opts.scope.subscriptionIds };
  }

  const subscriptions = await prisma.userSubscription.findMany({
    where: subscriptionWhere,
    select: {
      userId: true,
      strategyId: true,
      strategy: { select: { profitShare: true } },
    },
  });

  let invoicesCreated = 0;
  let invoicesAutoPaid = 0;
  let skipped = 0;

  for (const sub of subscriptions) {
    const trades = await prisma.trade.findMany({
      where: {
        userId: sub.userId,
        strategyId: sub.strategyId,
        status: TradeStatus.CLOSED,
        createdAt: { gte: start, lt: end },
      },
      select: { tradePnl: true, pnl: true },
    });

    const cumulativePnl = trades.reduce(
      (s, t) => s + realizedTradePnl(t),
      0,
    );
    const amountDue =
      cumulativePnl > 0
        ? cumulativePnl * (sub.strategy.profitShare / 100)
        : 0;

    if (amountDue <= 0) {
      skipped += 1;
      continue;
    }

    const dueDate = new Date(Date.now() + INVOICE_DUE_DAYS * MS_PER_DAY);

    try {
      const autoPaid = await prisma.$transaction(async (tx) => {
        const invoice = await tx.invoice.create({
          data: {
            userId: sub.userId,
            strategyId: sub.strategyId,
            month,
            year,
            totalPnl: cumulativePnl,
            amountDue,
            dueDate,
            status: InvoiceStatus.PENDING,
          },
        });

        const wallet = await tx.wallet.findUnique({
          where: { userId: sub.userId },
        });

        if (!wallet || wallet.balance < amountDue) {
          return false;
        }

        await tx.wallet.update({
          where: { id: wallet.id },
          data: { balance: { decrement: amountDue } },
        });
        await tx.walletTransaction.create({
          data: {
            walletId: wallet.id,
            amount: amountDue,
            type: WALLET_TXN_TYPE_INVOICE_PAYMENT,
            status: WALLET_TXN_STATUS_COMPLETED,
          },
        });
        await tx.invoice.update({
          where: { id: invoice.id },
          data: { status: InvoiceStatus.PAID },
        });
        return true;
      });

      invoicesCreated += 1;
      if (autoPaid) invoicesAutoPaid += 1;
    } catch (err) {
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === "P2002"
      ) {
        // Already invoiced for this (user, strategy, month, year).
        skipped += 1;
        continue;
      }
      throw err;
    }
  }

  return {
    month,
    year,
    invoicesCreated,
    invoicesAutoPaid,
    skipped,
  };
}

export type PayInvoiceOutcome =
  | { ok: true; invoiceId: string; amountDue: number; walletBalance: number }
  | {
      ok: false;
      status: 400 | 403 | 404 | 409;
      message: string;
    };

/**
 * Manually pay a PENDING invoice from the user's wallet balance.
 *
 * Atomic: wallet decrement + WalletTransaction insert + invoice flip to PAID
 * happen inside a single Prisma `$transaction`. Refuses if the invoice does
 * not exist, is not owned by `userId`, is not in PENDING state, or wallet
 * funds are insufficient.
 */
/**
 * Marks an invoice paid after an external gateway (e.g. Razorpay) — no wallet debit.
 */
export async function settleInvoiceAfterGateway(
  prisma: PrismaClient,
  args: { userId: string; invoiceId: string },
): Promise<PayInvoiceOutcome> {
  return prisma.$transaction(async (tx) => {
    const invoice = await tx.invoice.findUnique({
      where: { id: args.invoiceId },
    });
    if (!invoice) {
      return { ok: false, status: 404, message: "Invoice not found" } as const;
    }
    if (invoice.userId !== args.userId) {
      return {
        ok: false,
        status: 403,
        message: "You do not own this invoice",
      } as const;
    }
    if (invoice.status === InvoiceStatus.PAID) {
      return {
        ok: true,
        invoiceId: invoice.id,
        amountDue: invoice.amountDue,
        walletBalance:
          (await tx.wallet.findUnique({ where: { userId: args.userId } }))
            ?.balance ?? 0,
      } as const;
    }
    if (
      invoice.status !== InvoiceStatus.PENDING &&
      invoice.status !== InvoiceStatus.OVERDUE
    ) {
      return {
        ok: false,
        status: 400,
        message: `Invoice in unexpected status ${invoice.status}`,
      } as const;
    }

    await tx.invoice.update({
      where: { id: invoice.id },
      data: { status: InvoiceStatus.PAID },
    });

    await tx.userSubscription.updateMany({
      where: {
        userId: args.userId,
        strategyId: invoice.strategyId,
        status: SubscriptionStatus.PAUSED_DUE_TO_FUNDS,
      },
      data: { status: SubscriptionStatus.ACTIVE },
    });

    const wallet = await tx.wallet.findUnique({
      where: { userId: args.userId },
    });

    return {
      ok: true,
      invoiceId: invoice.id,
      amountDue: invoice.amountDue,
      walletBalance: wallet?.balance ?? 0,
    } as const;
  });
}

export type CreditWalletOutcome =
  | { ok: true; walletBalance: number; amountCredited: number }
  | { ok: false; status: number; message: string };

/**
 * Credits wallet balance after a Razorpay top-up (amount in USD).
 */
export async function creditWalletAfterGateway(
  prisma: PrismaClient,
  args: { userId: string; amountUsd: number },
): Promise<CreditWalletOutcome> {
  if (!Number.isFinite(args.amountUsd) || args.amountUsd <= 0) {
    return { ok: false, status: 400, message: "Invalid credit amount" };
  }

  return prisma.$transaction(async (tx) => {
    let wallet = await tx.wallet.findUnique({
      where: { userId: args.userId },
    });
    if (!wallet) {
      wallet = await tx.wallet.create({
        data: { userId: args.userId, balance: 0, pendingFees: 0 },
      });
    }

    const updated = await tx.wallet.update({
      where: { id: wallet.id },
      data: { balance: { increment: args.amountUsd } },
    });

    await tx.walletTransaction.create({
      data: {
        walletId: wallet.id,
        amount: args.amountUsd,
        type: "RAZORPAY_TOPUP",
        status: WALLET_TXN_STATUS_COMPLETED,
      },
    });

    return {
      ok: true,
      walletBalance: updated.balance,
      amountCredited: args.amountUsd,
    };
  });
}

export async function payInvoiceFromWallet(
  prisma: PrismaClient,
  args: { userId: string; invoiceId: string },
): Promise<PayInvoiceOutcome> {
  return prisma.$transaction(async (tx) => {
    const invoice = await tx.invoice.findUnique({
      where: { id: args.invoiceId },
    });
    if (!invoice) {
      return { ok: false, status: 404, message: "Invoice not found" } as const;
    }
    if (invoice.userId !== args.userId) {
      return {
        ok: false,
        status: 403,
        message: "You do not own this invoice",
      } as const;
    }
    if (invoice.status === InvoiceStatus.PAID) {
      return {
        ok: false,
        status: 409,
        message: "Invoice already paid",
      } as const;
    }
    if (
      invoice.status !== InvoiceStatus.PENDING &&
      invoice.status !== InvoiceStatus.OVERDUE
    ) {
      return {
        ok: false,
        status: 400,
        message: `Invoice in unexpected status ${invoice.status}`,
      } as const;
    }

    const wallet = await tx.wallet.findUnique({
      where: { userId: args.userId },
    });
    if (!wallet) {
      return {
        ok: false,
        status: 400,
        message: "Wallet not found. Top up first.",
      } as const;
    }
    if (wallet.balance < invoice.amountDue) {
      return {
        ok: false,
        status: 400,
        message: "Insufficient wallet balance",
      } as const;
    }

    const updatedWallet = await tx.wallet.update({
      where: { id: wallet.id },
      data: { balance: { decrement: invoice.amountDue } },
    });
    await tx.walletTransaction.create({
      data: {
        walletId: wallet.id,
        amount: invoice.amountDue,
        type: WALLET_TXN_TYPE_INVOICE_PAYMENT,
        status: WALLET_TXN_STATUS_COMPLETED,
      },
    });
    await tx.invoice.update({
      where: { id: invoice.id },
      data: { status: InvoiceStatus.PAID },
    });

    // Re-activate the subscription if it was paused for funds — paying the
    // outstanding invoice clears the dunning state.
    await tx.userSubscription.updateMany({
      where: {
        userId: args.userId,
        strategyId: invoice.strategyId,
        status: SubscriptionStatus.PAUSED_DUE_TO_FUNDS,
      },
      data: { status: SubscriptionStatus.ACTIVE },
    });

    return {
      ok: true,
      invoiceId: invoice.id,
      amountDue: invoice.amountDue,
      walletBalance: updatedWallet.balance,
    } as const;
  });
}

export interface OverdueCheckResult {
  invoicesMarkedOverdue: number;
  subscriptionsPaused: number;
}

/**
 * Daily overdue enforcement.
 *
 * Finds PENDING invoices whose `dueDate < now()`, flips them to OVERDUE, and
 * pauses the matching `(userId, strategyId)` `UserSubscription` (when still
 * ACTIVE) by setting it to `PAUSED_DUE_TO_FUNDS`.
 */
export async function runOverdueCheck(
  prisma: PrismaClient,
): Promise<OverdueCheckResult> {
  const now = new Date();

  const overdueInvoices = await prisma.invoice.findMany({
    where: {
      status: InvoiceStatus.PENDING,
      dueDate: { lt: now },
    },
    select: { id: true, userId: true, strategyId: true },
  });

  if (overdueInvoices.length === 0) {
    return { invoicesMarkedOverdue: 0, subscriptionsPaused: 0 };
  }

  const overdueIds = overdueInvoices.map((i) => i.id);
  const flip = await prisma.invoice.updateMany({
    where: { id: { in: overdueIds } },
    data: { status: InvoiceStatus.OVERDUE },
  });

  // Dedupe (userId, strategyId) — multiple overdue invoices for the same
  // pair only need one subscription update.
  const seen = new Set<string>();
  let subscriptionsPaused = 0;
  for (const inv of overdueInvoices) {
    const key = `${inv.userId}::${inv.strategyId}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const result = await prisma.userSubscription.updateMany({
      where: {
        userId: inv.userId,
        strategyId: inv.strategyId,
        status: SubscriptionStatus.ACTIVE,
      },
      data: { status: SubscriptionStatus.PAUSED_DUE_TO_FUNDS },
    });
    subscriptionsPaused += result.count;
  }

  return {
    invoicesMarkedOverdue: flip.count,
    subscriptionsPaused,
  };
}

/**
 * Convenience runner for tests / admin trigger — executes one full daily
 * billing cycle (overdue enforcement only; monthly invoice generation runs
 * on its own 1st-of-month schedule).
 */
export async function runBillingCycle(prisma: PrismaClient): Promise<void> {
  await runOverdueCheck(prisma);
}

/**
 * Schedules the two High-Water Mark cron jobs (UTC):
 *   • 00:05 UTC on the 1st of every month — `generateMonthlyInvoices`
 *   • 00:00 UTC daily                     — `runOverdueCheck`
 *
 * The 1st-of-month run is offset by 5 minutes so daily-overdue and
 * monthly-invoice never race for the same midnight tick.
 */
export function initBillingCronJobs(prisma: PrismaClient): void {
  cron.schedule(
    "5 0 1 * *",
    () => {
      void generateMonthlyInvoices(prisma)
        .then((res) => {
          console.log(
            `[billing] Monthly invoice run for ${res.year}-${String(res.month).padStart(2, "0")}: ` +
              `created=${res.invoicesCreated} autoPaid=${res.invoicesAutoPaid} skipped=${res.skipped}`,
          );
        })
        .catch((err) => {
          console.error("[billing] Monthly invoice run failed:", err);
        });
    },
    { timezone: "Etc/UTC" },
  );

  cron.schedule(
    "0 0 * * *",
    () => {
      void runOverdueCheck(prisma)
        .then((res) => {
          if (res.invoicesMarkedOverdue > 0 || res.subscriptionsPaused > 0) {
            console.log(
              `[billing] Daily overdue: invoices→OVERDUE=${res.invoicesMarkedOverdue}, subs→PAUSED_DUE_TO_FUNDS=${res.subscriptionsPaused}`,
            );
          }
        })
        .catch((err) => {
          console.error("[billing] Daily overdue run failed:", err);
        });
    },
    { timezone: "Etc/UTC" },
  );

  console.log(
    "[billing] Cron: monthly invoices @ 00:05 UTC on 1st; daily overdue @ 00:00 UTC",
  );
}
