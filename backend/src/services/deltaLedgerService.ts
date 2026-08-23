import { Prisma, type PrismaClient } from "@prisma/client";
import { guardedCron } from "../utils/cronGuard.js";
import { raiseAlert } from "../utils/systemAlert.js";
import { decryptDeltaSecretOrPlain } from "../utils/encryption.js";
import { fetchDeltaWalletTransactionsPage } from "./exchangeService.js";
import {
  calendarPartsInTimeZone,
  DASHBOARD_PNL_DAY_TIMEZONE,
} from "./dashboardMetricsService.js";
import {
  ATTRIBUTION_STATUS,
  findMatchingLegWindows,
  type LegWindowSpec,
} from "./structurePnlService.js";

const WALLET_TX_PAGE_SIZE = "100";
const WALLET_TX_MAX_PAGES = 500;
const DEFAULT_LOOKBACK_MS = 90 * 24 * 60 * 60 * 1000;
const BILLING_TIMEZONE = DASHBOARD_PNL_DAY_TIMEZONE;

function syncOverlapHours(): number {
  const raw = process.env.DELTA_SYNC_OVERLAP_HOURS?.trim();
  if (!raw) return 24;
  const n = parseFloat(raw);
  return Number.isFinite(n) && n > 0 ? n : 24;
}

function deepSweepDays(): number {
  const raw = process.env.DELTA_DEEP_SWEEP_DAYS?.trim();
  if (!raw) return 7;
  const n = parseFloat(raw);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : 7;
}

function syncOverlapMs(): number {
  return syncOverlapHours() * 60 * 60 * 1000;
}

export type IngestDeltaLedgerResult = {
  inserted: number;
  skipped: number;
  conflicts: number;
  lateRows: number;
  lastOccurredAt: Date | null;
};

export type DeltaLedgerCycleSummary = {
  users: number;
  accounts: number;
  inserted: number;
  skipped: number;
  conflicts: number;
  lateRows: number;
};

function emptyIngestResult(): IngestDeltaLedgerResult {
  return {
    inserted: 0,
    skipped: 0,
    conflicts: 0,
    lateRows: 0,
    lastOccurredAt: null,
  };
}

function numberOrNull(value: unknown): number | null {
  if (value === undefined || value === null) return null;
  const n = typeof value === "number" ? value : parseFloat(String(value));
  return Number.isFinite(n) ? n : null;
}

function toDecimalAmount(value: unknown): Prisma.Decimal {
  const raw = String(value ?? "0").trim();
  return new Prisma.Decimal(raw.length > 0 ? raw : "0");
}

function decimalStringsEqual(a: Prisma.Decimal, b: Prisma.Decimal): boolean {
  return a.toFixed(10) === b.toFixed(10);
}

function parseOccurredAt(row: Record<string, unknown>): Date | null {
  const raw = row.created_at;
  if (typeof raw === "string") {
    const d = new Date(raw);
    if (!Number.isNaN(d.getTime())) return d;
  }
  const n = numberOrNull(raw);
  if (n === null) return null;
  if (n > 1e15) return new Date(n / 1000);
  if (n > 1e12) return new Date(n);
  if (n > 1e9) return new Date(n * 1000);
  return null;
}

function extractProductSymbol(row: Record<string, unknown>): string | null {
  const meta = row.meta_data;
  if (meta != null && typeof meta === "object") {
    const sym = (meta as Record<string, unknown>).product_symbol;
    if (typeof sym === "string" && sym.trim().length > 0) return sym.trim();
  }
  const direct = row.product_symbol;
  if (typeof direct === "string" && direct.trim().length > 0) return direct.trim();
  return null;
}

function extractBalanceAfter(row: Record<string, unknown>): Prisma.Decimal | null {
  const candidates = [row.balance_after, row.wallet_balance, row.balance];
  for (const raw of candidates) {
    if (raw === undefined || raw === null) continue;
    return toDecimalAmount(raw);
  }
  return null;
}

/** Earliest fetch window — overlap prior cursor (default 24h, env override). */
export function resolveDeltaLedgerSyncSince(
  syncedUpTo: Date | null | undefined,
): Date {
  if (syncedUpTo instanceof Date && !Number.isNaN(syncedUpTo.getTime())) {
    return new Date(syncedUpTo.getTime() - syncOverlapMs());
  }
  return new Date(Date.now() - DEFAULT_LOOKBACK_MS);
}

/** Deep sweep lookback — independent of ingestion cursor. */
export function resolveDeltaLedgerDeepSweepSince(ref = new Date()): Date {
  return new Date(ref.getTime() - deepSweepDays() * 24 * 60 * 60 * 1000);
}

async function fetchAllWalletTransactionsSince(
  apiKey: string,
  apiSecret: string,
  since: Date,
): Promise<Record<string, unknown>[]> {
  const all: Record<string, unknown>[] = [];
  const startTimeMicros = String(since.getTime() * 1000);
  let after: string | undefined;

  for (let page = 0; page < WALLET_TX_MAX_PAGES; page += 1) {
    const query: Record<string, string> = {
      start_time: startTimeMicros,
      page_size: WALLET_TX_PAGE_SIZE,
    };
    if (after) query.after = after;

    const { rows, after: nextAfter } = await fetchDeltaWalletTransactionsPage(
      apiKey,
      apiSecret,
      query,
    );
    all.push(...rows);

    if (!nextAfter || rows.length === 0) break;
    after = nextAfter;
  }

  return all;
}

async function markStructuresSuspectForLedgerEvent(
  prisma: PrismaClient,
  userId: string,
  productId: number,
  occurredAt: Date,
  reason: string,
): Promise<void> {
  const legs = await prisma.structureLegPnl.findMany({
    where: { structure: { userId, isSimulated: false } },
    select: {
      botLegId: true,
      productId: true,
      openedAt: true,
      attributionFrom: true,
      closedAt: true,
      structure: {
        select: {
          id: true,
          botStructureId: true,
          attributionStatus: true,
          attributionNote: true,
        },
      },
    },
  });

  const specs: LegWindowSpec[] = legs.map((leg) => ({
    botStructureId: leg.structure.botStructureId,
    botLegId: leg.botLegId,
    productId: leg.productId,
    openedAt: leg.openedAt,
    attributionFrom: leg.attributionFrom,
    closedAt: leg.closedAt,
  }));

  const matching = findMatchingLegWindows({ productId, occurredAt }, specs);
  if (matching.length === 0) return;

  const structureIds = new Set<string>();
  for (const hit of matching) {
    const leg = legs.find(
      (row) =>
        row.structure.botStructureId === hit.botStructureId &&
        row.botLegId === hit.botLegId,
    );
    if (leg) structureIds.add(leg.structure.id);
  }

  const now = new Date();
  for (const structureId of structureIds) {
    const structure = legs.find((l) => l.structure.id === structureId)?.structure;
    if (!structure) continue;

    const note = structure.attributionNote
      ? `${structure.attributionNote}; ${reason}`
      : reason;

    await prisma.structurePnl.update({
      where: { id: structureId },
      data: {
        attributionStatus: ATTRIBUTION_STATUS.SUSPECT_INCOMPLETE,
        attributionNote: note,
        computedAt: now,
      },
    });
  }
}

async function flagLateRowIfInvoicedPeriod(
  prisma: PrismaClient,
  userId: string,
  deltaUuid: string,
  occurredAt: Date,
): Promise<boolean> {
  const { year, month } = calendarPartsInTimeZone(occurredAt, BILLING_TIMEZONE);
  const invoice = await prisma.monthlyRevenueInvoice.findUnique({
    where: {
      userId_periodYear_periodMonth: {
        userId,
        periodYear: year,
        periodMonth: month,
      },
    },
    select: { id: true },
  });
  if (!invoice) return false;

  await prisma.user.update({
    where: { id: userId },
    data: { deltaLedgerRecomputeRequired: true },
  });

  console.error(
    `[DeltaLedger] LATE ROW user=${userId} uuid=${deltaUuid} occurredAt=${occurredAt.toISOString()} ` +
      `affects period ${year}-${String(month).padStart(2, "0")} -- recompute required`,
  );
  return true;
}

/**
 * Ingest Delta wallet transactions for one user (one exchange account) from `since` forward.
 * Rows are keyed on (userId, deltaUuid) — safe to retry; stored amounts are never overwritten.
 */
export async function ingestDeltaLedgerForUser(
  prisma: PrismaClient,
  args: {
    userId: string;
    apiKey: string;
    apiSecret: string;
    since: Date;
    /** When true, newly inserted rows in invoiced periods flag recompute. */
    deepSweep?: boolean;
    /** Account that produced these wallet rows (null only for legacy callers). */
    exchangeAccountId?: string;
  },
): Promise<IngestDeltaLedgerResult> {
  const rows = await fetchAllWalletTransactionsSince(
    args.apiKey,
    args.apiSecret,
    args.since,
  );

  let inserted = 0;
  let skipped = 0;
  let conflicts = 0;
  let lateRows = 0;
  let lastOccurredAt: Date | null = null;

  for (const row of rows) {
    const deltaUuid =
      typeof row.uuid === "string"
        ? row.uuid.trim()
        : typeof row.id === "string"
          ? row.id.trim()
          : row.id != null
            ? String(row.id).trim()
            : "";
    if (!deltaUuid) {
      skipped += 1;
      continue;
    }

    const occurredAt = parseOccurredAt(row);
    if (!occurredAt) {
      skipped += 1;
      continue;
    }

    if (!lastOccurredAt || occurredAt > lastOccurredAt) {
      lastOccurredAt = occurredAt;
    }

    const amount = toDecimalAmount(row.amount);
    const transactionType = String(row.transaction_type ?? "unknown").trim() || "unknown";
    const productId = numberOrNull(row.product_id);
    const productSymbol = extractProductSymbol(row);
    const balanceAfter = extractBalanceAfter(row);
    const metaJson =
      row.meta_data != null && typeof row.meta_data === "object"
        ? (row.meta_data as Prisma.InputJsonValue)
        : undefined;

    const existing = await prisma.deltaLedgerEntry.findUnique({
      where: {
        userId_deltaUuid: {
          userId: args.userId,
          deltaUuid,
        },
      },
    });

    if (existing) {
      if (!decimalStringsEqual(existing.amount, amount)) {
        conflicts += 1;
        const conflictSeenAt = new Date();
        await prisma.deltaLedgerEntry.update({
          where: { id: existing.id },
          data: {
            conflictAmount: amount,
            conflictSeenAt,
          },
        });

        if (productId != null) {
          await markStructuresSuspectForLedgerEvent(
            prisma,
            args.userId,
            Math.trunc(productId),
            occurredAt,
            "ledger amount conflict",
          );
        }

        console.error(
          `[DeltaLedger] CONFLICT user=${args.userId} uuid=${deltaUuid} product=${productId ?? "null"} ` +
            `stored=${existing.amount.toFixed(10)} incoming=${amount.toFixed(10)} -- legs marked SUSPECT`,
        );
      }
      skipped += 1;
      continue;
    }

    await prisma.deltaLedgerEntry.create({
      data: {
        userId: args.userId,
        ...(args.exchangeAccountId
          ? { exchangeAccountId: args.exchangeAccountId }
          : {}),
        deltaUuid,
        productId: productId != null ? Math.trunc(productId) : null,
        productSymbol,
        transactionType,
        amount,
        balanceAfter,
        ...(metaJson !== undefined ? { metaJson } : {}),
        occurredAt,
      },
    });
    inserted += 1;

    if (args.deepSweep) {
      const isLate = await flagLateRowIfInvoicedPeriod(
        prisma,
        args.userId,
        deltaUuid,
        occurredAt,
      );
      if (isLate) lateRows += 1;
    }
  }

  return { inserted, skipped, conflicts, lateRows, lastOccurredAt };
}

type EligibleLedgerAccount = {
  userId: string;
  exchangeAccountId: string;
  apiKeyStored: string;
  apiSecretStored: string;
  syncedUpTo: Date | null;
  email: string | null;
};

/**
 * Eligible = users with an active bot-strategy subscription.
 * Sync target = every ExchangeAccount for those users that has credentials
 * (not just the first / subscription-linked account).
 */
/**
 * Ledger sync eligibility: any user with structure P&L rows (open or closed).
 * Ingest must not stop on pause — missing ledger rows are permanent data loss.
 */
async function listEligibleDeltaLedgerUserIds(
  prisma: PrismaClient,
): Promise<string[]> {
  const rows = await prisma.structurePnl.findMany({
    select: { userId: true },
    distinct: ["userId"],
  });
  return rows.map((r) => r.userId);
}

async function listEligibleDeltaLedgerAccounts(
  prisma: PrismaClient,
): Promise<EligibleLedgerAccount[]> {
  const eligibleUserIds = await listEligibleDeltaLedgerUserIds(prisma);
  if (eligibleUserIds.length === 0) return [];

  const users = await prisma.user.findMany({
    where: { id: { in: eligibleUserIds } },
    select: { id: true, email: true },
  });
  const emailByUser = new Map(users.map((u) => [u.id, u.email ?? null] as const));

  const accounts = await prisma.exchangeAccount.findMany({
    where: { userId: { in: eligibleUserIds } },
    select: {
      id: true,
      userId: true,
      apiKey: true,
      apiSecret: true,
      deltaLedgerSyncedUpTo: true,
    },
    orderBy: { createdAt: "asc" },
  });

  const result: EligibleLedgerAccount[] = [];
  const usersWithCreds = new Set<string>();
  const missingCredsByUser = new Map<string, string>();

  for (const userId of eligibleUserIds) {
    missingCredsByUser.set(userId, emailByUser.get(userId) ?? "(no email)");
  }

  for (const account of accounts) {
    if (!account.apiKey?.trim() || !account.apiSecret?.trim()) continue;
    usersWithCreds.add(account.userId);
    missingCredsByUser.delete(account.userId);
    result.push({
      userId: account.userId,
      exchangeAccountId: account.id,
      apiKeyStored: account.apiKey,
      apiSecretStored: account.apiSecret,
      syncedUpTo: account.deltaLedgerSyncedUpTo,
      email: emailByUser.get(account.userId) ?? null,
    });
  }

  for (const [userId, email] of missingCredsByUser) {
    console.warn(
      `[DeltaLedger] SKIP user=${userId} email=${email} reason=no_credentials`,
    );
  }
  if (missingCredsByUser.size > 0) {
    console.warn(
      `[DeltaLedger] ${missingCredsByUser.size} users skipped for missing credentials`,
    );
  }

  void usersWithCreds;
  return result;
}

function mergeIntoCycleSummary(
  target: DeltaLedgerCycleSummary,
  source: IngestDeltaLedgerResult,
): void {
  target.inserted += source.inserted;
  target.skipped += source.skipped;
  target.conflicts += source.conflicts;
  target.lateRows += source.lateRows;
}

function logDeltaLedgerCycleSummary(summary: DeltaLedgerCycleSummary): void {
  console.log(
    `[DeltaLedger] cycle users=${summary.users} accounts=${summary.accounts} ` +
      `inserted=${summary.inserted} skipped=${summary.skipped} ` +
      `conflicts=${summary.conflicts} lateRows=${summary.lateRows}`,
  );
  if (summary.conflicts > 0 || summary.lateRows > 0) {
    console.error(
      `[DeltaLedger] cycle ALERT conflicts=${summary.conflicts} lateRows=${summary.lateRows} -- review required`,
    );
    void raiseAlert({
      key: "ledger-reconcile",
      severity: "WARN",
      source: "deltaLedgerSync",
      message: `Ledger sync cycle found ${summary.conflicts} conflict(s) and ${summary.lateRows} late row(s)`,
      detail: summary,
    });
  }
}

async function syncOneEligibleAccount(
  prisma: PrismaClient,
  account: EligibleLedgerAccount,
  opts?: { since?: Date; deepSweep?: boolean; advanceCursor?: boolean },
): Promise<IngestDeltaLedgerResult> {
  const since = opts?.since ?? resolveDeltaLedgerSyncSince(account.syncedUpTo);
  const apiKey = decryptDeltaSecretOrPlain(account.apiKeyStored);
  const apiSecret = decryptDeltaSecretOrPlain(account.apiSecretStored);

  const result = await ingestDeltaLedgerForUser(prisma, {
    userId: account.userId,
    apiKey,
    apiSecret,
    since,
    exchangeAccountId: account.exchangeAccountId,
    ...(opts?.deepSweep ? { deepSweep: true } : {}),
  });

  const advanceCursor = opts?.advanceCursor ?? !opts?.deepSweep;
  if (advanceCursor && result.lastOccurredAt) {
    const prior = account.syncedUpTo;
    const next =
      prior && prior > result.lastOccurredAt ? prior : result.lastOccurredAt;
    await prisma.exchangeAccount.update({
      where: { id: account.exchangeAccountId },
      data: { deltaLedgerSyncedUpTo: next },
    });
    // Legacy User cursor = max across accounts (admin health); never move it backward.
    const userRow = await prisma.user.findUnique({
      where: { id: account.userId },
      select: { deltaLedgerSyncedUpTo: true },
    });
    const userNext =
      userRow?.deltaLedgerSyncedUpTo &&
      userRow.deltaLedgerSyncedUpTo > next
        ? userRow.deltaLedgerSyncedUpTo
        : next;
    await prisma.user.update({
      where: { id: account.userId },
      data: { deltaLedgerSyncedUpTo: userNext },
    });
  }

  console.log(
    `[DeltaLedger] user=${account.userId} account=${account.exchangeAccountId} ` +
      `inserted=${result.inserted} skipped=${result.skipped} ` +
      `conflicts=${result.conflicts} lateRows=${result.lateRows} ` +
      `upTo=${result.lastOccurredAt?.toISOString() ?? "n/a"}`,
  );

  return result;
}

function mergeUserResults(
  a: IngestDeltaLedgerResult,
  b: IngestDeltaLedgerResult,
): IngestDeltaLedgerResult {
  const lastOccurredAt =
    a.lastOccurredAt && b.lastOccurredAt
      ? a.lastOccurredAt > b.lastOccurredAt
        ? a.lastOccurredAt
        : b.lastOccurredAt
      : (a.lastOccurredAt ?? b.lastOccurredAt);
  return {
    inserted: a.inserted + b.inserted,
    skipped: a.skipped + b.skipped,
    conflicts: a.conflicts + b.conflicts,
    lateRows: a.lateRows + b.lateRows,
    lastOccurredAt,
  };
}

/** Run ledger ingestion for every exchange account of eligible bot-strategy users. */
export async function runDeltaLedgerSyncForUsers(
  prisma: PrismaClient,
  opts?: { userId?: string },
): Promise<Record<string, IngestDeltaLedgerResult>> {
  let accounts = await listEligibleDeltaLedgerAccounts(prisma);
  if (opts?.userId) {
    accounts = accounts.filter((a) => a.userId === opts.userId);
  }

  const userIds = new Set(accounts.map((a) => a.userId));
  const summary: DeltaLedgerCycleSummary = {
    users: userIds.size,
    accounts: accounts.length,
    inserted: 0,
    skipped: 0,
    conflicts: 0,
    lateRows: 0,
  };

  const results: Record<string, IngestDeltaLedgerResult> = {};
  for (const account of accounts) {
    try {
      const result = await syncOneEligibleAccount(prisma, account);
      results[account.userId] = results[account.userId]
        ? mergeUserResults(results[account.userId]!, result)
        : result;
      mergeIntoCycleSummary(summary, result);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(
        `[DeltaLedger] sync failed user=${account.userId} account=${account.exchangeAccountId}: ${msg}`,
      );
      void raiseAlert({
        key: `delta-ledger-sync:${account.exchangeAccountId}`,
        severity: "CRITICAL",
        source: "deltaLedgerSync",
        message: `Delta ledger sync failed for account ${account.exchangeAccountId}: ${msg}`,
        detail: {
          userId: account.userId,
          exchangeAccountId: account.exchangeAccountId,
        },
      });
      if (!results[account.userId]) {
        results[account.userId] = emptyIngestResult();
      }
    }
  }

  logDeltaLedgerCycleSummary(summary);
  return results;
}

/** Re-fetch last N days for every eligible exchange account (idempotent via deltaUuid). */
export async function runDeltaLedgerDeepSweep(
  prisma: PrismaClient,
): Promise<DeltaLedgerCycleSummary> {
  const accounts = await listEligibleDeltaLedgerAccounts(prisma);
  const since = resolveDeltaLedgerDeepSweepSince();
  const userIds = new Set(accounts.map((a) => a.userId));

  const summary: DeltaLedgerCycleSummary = {
    users: userIds.size,
    accounts: accounts.length,
    inserted: 0,
    skipped: 0,
    conflicts: 0,
    lateRows: 0,
  };

  console.log(
    `[DeltaLedger] deep sweep start users=${userIds.size} accounts=${accounts.length} ` +
      `since=${since.toISOString()} days=${deepSweepDays()}`,
  );

  for (const account of accounts) {
    try {
      const result = await syncOneEligibleAccount(prisma, account, {
        since,
        deepSweep: true,
        advanceCursor: false,
      });
      mergeIntoCycleSummary(summary, result);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(
        `[DeltaLedger] deep sweep failed user=${account.userId} account=${account.exchangeAccountId}: ${msg}`,
      );
    }
  }

  logDeltaLedgerCycleSummary(summary);
  return summary;
}

async function runDeltaLedgerSyncCycle(prisma: PrismaClient): Promise<void> {
  await runDeltaLedgerSyncForUsers(prisma);
}

/** Poll Delta wallet transactions every 5 minutes for active bot-strategy subscribers. */
export function initDeltaLedgerCronJobs(prisma: PrismaClient): void {
  guardedCron(
    "delta-ledger-sync",
    "*/5 * * * *",
    async () => {
      await runDeltaLedgerSyncCycle(prisma);
    },
    { timezone: "Etc/UTC" },
  );

  guardedCron(
    "delta-ledger-deep-sweep",
    "30 2 * * *",
    async () => {
      await runDeltaLedgerDeepSweep(prisma);
    },
    { timezone: BILLING_TIMEZONE },
  );

  console.log(
    `[DeltaLedger] Scheduled wallet sync every 5 min UTC; deep sweep @ 02:30 IST ` +
      `(overlap=${syncOverlapHours()}h, sweep=${deepSweepDays()}d)`,
  );
}
