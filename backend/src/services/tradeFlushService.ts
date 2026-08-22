import fs from "node:fs/promises";
import path from "node:path";
import {
  InvoiceStatus,
  TradeStatus,
  type Prisma,
  type PrismaClient,
} from "@prisma/client";

type DbClient = PrismaClient | Prisma.TransactionClient;
import {
  endOfUtcDay,
  realizedTradePnl,
  startOfUtcDay,
} from "./dashboardMetricsService.js";
import { logAdminActionOrThrow } from "../utils/auditLogger.js";

export type TradeFlushRow = {
  id: string;
  strategyId: string;
  tradePnl: number;
  pnl: number | null;
  createdAt: Date;
};

export type PurgeAnalyticsResult = {
  pnlRecordsRemoved: number;
  commissionLedgersRemoved: number;
};

/** Remove PnL rows and partner commission ledger entries tied to deleted trades. */
export async function purgeAnalyticsForDeletedTrades(
  prisma: DbClient,
  userId: string,
  trades: TradeFlushRow[],
  flushAllForUser: boolean,
): Promise<PurgeAnalyticsResult> {
  if (flushAllForUser) {
    const commissionOut = await prisma.commissionLedger.deleteMany({
      where: {
        OR: [{ sourceUserId: userId }, { pnlRecord: { userId } }],
      },
    });
    const pnlOut = await prisma.pnLRecord.deleteMany({ where: { userId } });
    return {
      pnlRecordsRemoved: pnlOut.count,
      commissionLedgersRemoved: commissionOut.count,
    };
  }

  let pnlRecordsRemoved = 0;
  let commissionLedgersRemoved = 0;

  type Slice = { strategyId: string; dayStart: Date; dayEnd: Date };
  const slices = new Map<string, Slice>();

  for (const t of trades) {
    const dayStart = startOfUtcDay(t.createdAt);
    const dayEnd = endOfUtcDay(t.createdAt);
    const key = `${t.strategyId}:${dayStart.getTime()}`;
    if (!slices.has(key)) {
      slices.set(key, { strategyId: t.strategyId, dayStart, dayEnd });
    }
  }

  const purgedPnlIds = new Set<string>();

  for (const slice of slices.values()) {
    const remainingTrades = await prisma.trade.count({
      where: {
        userId,
        strategyId: slice.strategyId,
        status: { not: TradeStatus.OPEN },
        createdAt: { gte: slice.dayStart, lte: slice.dayEnd },
      },
    });

    if (remainingTrades === 0) {
      const pnls = await prisma.pnLRecord.findMany({
        where: {
          userId,
          strategyId: slice.strategyId,
          timestamp: { gte: slice.dayStart, lte: slice.dayEnd },
        },
        select: { id: true },
      });
      const pnlIds = pnls.map((p) => p.id);
      if (pnlIds.length > 0) {
        const comm = await prisma.commissionLedger.deleteMany({
          where: { pnlRecordId: { in: pnlIds } },
        });
        commissionLedgersRemoved += comm.count;
        const pnlDel = await prisma.pnLRecord.deleteMany({
          where: { id: { in: pnlIds } },
        });
        pnlRecordsRemoved += pnlDel.count;
        for (const id of pnlIds) purgedPnlIds.add(id);
      }
      const orphanComm = await prisma.commissionLedger.deleteMany({
        where: {
          sourceUserId: userId,
          profitDate: slice.dayStart,
        },
      });
      commissionLedgersRemoved += orphanComm.count;
      continue;
    }

    const tradesInSlice = trades.filter(
      (t) =>
        t.strategyId === slice.strategyId &&
        t.createdAt >= slice.dayStart &&
        t.createdAt <= slice.dayEnd,
    );

    for (const t of tradesInSlice) {
      const profit = realizedTradePnl(t);
      const whereBase = {
        userId,
        strategyId: t.strategyId,
        timestamp: { gte: slice.dayStart, lte: slice.dayEnd },
        ...(purgedPnlIds.size > 0
          ? { id: { notIn: [...purgedPnlIds] } }
          : {}),
      };

      let matchId: string | null = null;
      if (Number.isFinite(profit)) {
        const match = await prisma.pnLRecord.findFirst({
          where: { ...whereBase, profitAmount: profit },
          orderBy: { timestamp: "desc" },
          select: { id: true },
        });
        matchId = match?.id ?? null;
      }

      if (!matchId) {
        const dayRows = await prisma.pnLRecord.findMany({
          where: whereBase,
          select: { id: true },
        });
        if (dayRows.length === 1) {
          matchId = dayRows[0]!.id;
        }
      }

      if (matchId && !purgedPnlIds.has(matchId)) {
        const comm = await prisma.commissionLedger.deleteMany({
          where: { pnlRecordId: matchId },
        });
        commissionLedgersRemoved += comm.count;
        await prisma.pnLRecord.delete({ where: { id: matchId } });
        pnlRecordsRemoved += 1;
        purgedPnlIds.add(matchId);
      }
    }
  }

  return { pnlRecordsRemoved, commissionLedgersRemoved };
}

export function buildFlushableTradeWhere(
  userId: string,
  tradeIds?: string[],
): {
  userId: string;
  status: { not: TradeStatus };
  id?: { in: string[] };
} {
  const where = {
    userId,
    status: { not: TradeStatus.OPEN },
  };
  if (tradeIds && tradeIds.length > 0) {
    return { ...where, id: { in: tradeIds } };
  }
  return where;
}

export const FLUSH_ALL_PLATFORM_CONFIRM_PHRASE = "FLUSH ALL TRADES";

export const PURGE_PLATFORM_FINANCIALS_ACTION = "PURGE_PLATFORM_FINANCIALS";

export type FinancialPurgeCounts = {
  commissionLedger: number;
  pnLRecord: number;
  invoice: number;
};

export type FinancialPurgeSnapshot = {
  /** Path relative to process cwd, e.g. backups/purge-….json */
  backupPath: string;
  absolutePath: string;
  counts: FinancialPurgeCounts;
};

function jsonReplacer(_key: string, value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (
    value != null &&
    typeof value === "object" &&
    "toNumber" in value &&
    typeof (value as { toNumber: unknown }).toNumber === "function"
  ) {
    return (value as { toNumber: () => number }).toNumber();
  }
  return value;
}

/**
 * Write a full JSON snapshot of every financial row about to be deleted.
 * Purge must not proceed unless this succeeds.
 */
export async function snapshotBeforePurge(
  prisma: PrismaClient,
  scope: string,
): Promise<FinancialPurgeSnapshot> {
  const safeScope = scope.replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-|-$/g, "") || "platform";
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const fileName = `purge-${stamp}-${safeScope}.json`;
  const backupsDir = path.resolve(process.cwd(), "backups");
  const absolutePath = path.join(backupsDir, fileName);
  const backupPath = path.join("backups", fileName).replace(/\\/g, "/");

  const invoiceWhere = {
    status: { in: [InvoiceStatus.PENDING, InvoiceStatus.OVERDUE] },
  };

  const [commissionLedger, pnLRecord, invoice] = await Promise.all([
    prisma.commissionLedger.findMany(),
    prisma.pnLRecord.findMany(),
    prisma.invoice.findMany({ where: invoiceWhere }),
  ]);

  const payload = {
    createdAt: new Date().toISOString(),
    scope: safeScope,
    counts: {
      commissionLedger: commissionLedger.length,
      pnLRecord: pnLRecord.length,
      invoice: invoice.length,
    },
    commissionLedger,
    pnLRecord,
    invoice,
  };

  try {
    await fs.mkdir(backupsDir, { recursive: true });
    await fs.writeFile(
      absolutePath,
      JSON.stringify(payload, jsonReplacer, 2),
      "utf8",
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Financial purge aborted: failed to write backup snapshot (${backupPath}): ${message}`,
    );
  }

  // Confirm the file is readable before allowing deletes.
  try {
    await fs.access(absolutePath);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Financial purge aborted: backup snapshot not readable (${backupPath}): ${message}`,
    );
  }

  return {
    backupPath,
    absolutePath,
    counts: {
      commissionLedger: commissionLedger.length,
      pnLRecord: pnLRecord.length,
      invoice: invoice.length,
    },
  };
}

export type FlushAllPlatformResult = {
  deletedTrades: number;
  pnlRecordsRemoved: number;
  commissionLedgersRemoved: number;
  pendingInvoicesRemoved: number;
  tradePositionsRemoved: number;
  openTradesPreserved: number;
  backupPath: string | null;
};

/** Wipe every PnL row and partner commission ledger (platform-wide reset). */
export async function purgeAllPlatformAnalytics(
  prisma: DbClient,
): Promise<PurgeAnalyticsResult> {
  const commissionOut = await prisma.commissionLedger.deleteMany({});
  const pnlOut = await prisma.pnLRecord.deleteMany({});
  return {
    pnlRecordsRemoved: pnlOut.count,
    commissionLedgersRemoved: commissionOut.count,
  };
}

export type FlushAllPlatformTradesOpts = {
  includeOpen?: boolean;
  /** Clear analytics + pending invoices even when no flushable trade rows exist. */
  purgeFinancialsOnly?: boolean;
  /** Required for irreversible financial purge — audit failure aborts the purge. */
  audit: {
    adminId: string;
    ip?: string | null;
  };
};

/**
 * Delete copy-trade history for every user and reset related billing analytics.
 * OPEN exchange legs are preserved unless `includeOpen` is true.
 * Always snapshots financial rows to disk before any delete.
 */
export async function flushAllPlatformTrades(
  prisma: PrismaClient,
  opts: FlushAllPlatformTradesOpts,
): Promise<FlushAllPlatformResult> {
  const includeOpen = opts.includeOpen === true;
  const purgeFinancialsOnly = opts.purgeFinancialsOnly === true;
  const { adminId, ip } = opts.audit;

  const tradeWhere = includeOpen
    ? {}
    : { status: { not: TradeStatus.OPEN } };

  const flushableCount = await prisma.trade.count({ where: tradeWhere });
  const openTradesPreserved = includeOpen
    ? 0
    : await prisma.trade.count({ where: { status: TradeStatus.OPEN } });

  if (flushableCount === 0 && !purgeFinancialsOnly) {
    return {
      deletedTrades: 0,
      pnlRecordsRemoved: 0,
      commissionLedgersRemoved: 0,
      pendingInvoicesRemoved: 0,
      tradePositionsRemoved: 0,
      openTradesPreserved,
      backupPath: null,
    };
  }

  const scope = purgeFinancialsOnly
    ? includeOpen
      ? "platform-financials-only-include-open"
      : "platform-financials-only"
    : includeOpen
      ? "platform-all-include-open"
      : "platform-all";

  const snapshot = await snapshotBeforePurge(prisma, scope);

  const beforeDetails = {
    scope,
    backupPath: snapshot.backupPath,
    phase: "before",
    counts: snapshot.counts,
  };

  await logAdminActionOrThrow(
    prisma,
    adminId,
    PURGE_PLATFORM_FINANCIALS_ACTION,
    "platform",
    null,
    beforeDetails,
    ip,
  );

  const result = await prisma.$transaction(async (tx) => {
    const purged = await purgeAllPlatformAnalytics(tx);

    const invoiceOut = await tx.invoice.deleteMany({
      where: {
        status: { in: [InvoiceStatus.PENDING, InvoiceStatus.OVERDUE] },
      },
    });

    let tradePositionsRemoved = 0;
    if (includeOpen) {
      const posOut = await tx.tradePosition.deleteMany({});
      tradePositionsRemoved = posOut.count;
    }

    const tradeOut = await tx.trade.deleteMany({ where: tradeWhere });

    const afterDetails = {
      scope,
      backupPath: snapshot.backupPath,
      phase: "after",
      counts: {
        commissionLedger: purged.commissionLedgersRemoved,
        pnLRecord: purged.pnlRecordsRemoved,
        invoice: invoiceOut.count,
      },
    };

    // Inside the same transaction: if this fails, deletes roll back.
    await logAdminActionOrThrow(
      tx,
      adminId,
      PURGE_PLATFORM_FINANCIALS_ACTION,
      "platform",
      null,
      afterDetails,
      ip,
    );

    return {
      deletedTrades: tradeOut.count,
      ...purged,
      pendingInvoicesRemoved: invoiceOut.count,
      tradePositionsRemoved,
      openTradesPreserved,
      backupPath: snapshot.backupPath,
    };
  });

  return result;
}
