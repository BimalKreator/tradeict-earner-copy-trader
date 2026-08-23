import { Prisma, type PrismaClient } from "@prisma/client";
import cron from "node-cron";
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
 * Ingest Delta wallet transactions for one user from `since` forward.
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

type EligibleLedgerUser = {
  userId: string;
  apiKeyStored: string;
  apiSecretStored: string;
  syncedUpTo: Date | null;
};

function credsFromExchangeAccount(
  row: { apiKey: string; apiSecret: string } | null | undefined,
): { apiKeyStored: string; apiSecretStored: string } | null {
  if (!row?.apiKey?.trim() || !row?.apiSecret?.trim()) return null;
  return { apiKeyStored: row.apiKey, apiSecretStored: row.apiSecret };
}

async function listEligibleDeltaLedgerUsers(
  prisma: PrismaClient,
): Promise<EligibleLedgerUser[]> {
  const subs = await prisma.userStrategySubscription.findMany({
    where: {
      OR: [{ isActive: true }, { status: "ACTIVE" }],
      strategy: {
        AND: [
          { botStrategyType: { not: null } },
          { NOT: { botStrategyType: "" } },
        ],
      },
    },
    include: {
      exchangeAccount: {
        select: { apiKey: true, apiSecret: true },
      },
      user: {
        select: {
          id: true,
          email: true,
          deltaLedgerSyncedUpTo: true,
          exchangeAccounts: {
            orderBy: { createdAt: "desc" },
            take: 1,
            select: { apiKey: true, apiSecret: true },
          },
        },
      },
    },
  });

  const byUser = new Map<string, EligibleLedgerUser>();
  const missingCredsByUser = new Map<string, string>();

  for (const sub of subs) {
    if (byUser.has(sub.userId)) continue;

    const creds =
      credsFromExchangeAccount(sub.exchangeAccount) ??
      credsFromExchangeAccount(sub.user.exchangeAccounts[0] ?? null);

    if (!creds) {
      const email = sub.user.email ?? "(no email)";
      if (!missingCredsByUser.has(sub.userId)) {
        console.warn(
          `[DeltaLedger] SKIP user=${sub.userId} email=${email} reason=no_credentials`,
        );
        missingCredsByUser.set(sub.userId, email);
      }
      continue;
    }

    missingCredsByUser.delete(sub.userId);
    byUser.set(sub.userId, {
      userId: sub.userId,
      apiKeyStored: creds.apiKeyStored,
      apiSecretStored: creds.apiSecretStored,
      syncedUpTo: sub.user.deltaLedgerSyncedUpTo,
    });
  }

  if (missingCredsByUser.size > 0) {
    console.warn(
      `[DeltaLedger] ${missingCredsByUser.size} users skipped for missing credentials`,
    );
  }

  return [...byUser.values()];
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
    `[DeltaLedger] cycle users=${summary.users} inserted=${summary.inserted} ` +
      `skipped=${summary.skipped} conflicts=${summary.conflicts} lateRows=${summary.lateRows}`,
  );
  if (summary.conflicts > 0 || summary.lateRows > 0) {
    console.error(
      `[DeltaLedger] cycle ALERT conflicts=${summary.conflicts} lateRows=${summary.lateRows} -- review required`,
    );
  }
}

async function syncOneEligibleUser(
  prisma: PrismaClient,
  user: EligibleLedgerUser,
  opts?: { since?: Date; deepSweep?: boolean; advanceCursor?: boolean },
): Promise<IngestDeltaLedgerResult> {
  const since = opts?.since ?? resolveDeltaLedgerSyncSince(user.syncedUpTo);
  const apiKey = decryptDeltaSecretOrPlain(user.apiKeyStored);
  const apiSecret = decryptDeltaSecretOrPlain(user.apiSecretStored);

  const result = await ingestDeltaLedgerForUser(prisma, {
    userId: user.userId,
    apiKey,
    apiSecret,
    since,
    ...(opts?.deepSweep ? { deepSweep: true } : {}),
  });

  const advanceCursor = opts?.advanceCursor ?? !opts?.deepSweep;
  if (advanceCursor && result.lastOccurredAt) {
    const prior = user.syncedUpTo;
    const next =
      prior && prior > result.lastOccurredAt ? prior : result.lastOccurredAt;
    await prisma.user.update({
      where: { id: user.userId },
      data: { deltaLedgerSyncedUpTo: next },
    });
  }

  console.log(
    `[DeltaLedger] user=${user.userId} inserted=${result.inserted} skipped=${result.skipped} ` +
      `conflicts=${result.conflicts} lateRows=${result.lateRows} ` +
      `upTo=${result.lastOccurredAt?.toISOString() ?? "n/a"}`,
  );

  return result;
}

/** Run ledger ingestion for eligible users (optional single-user filter). */
export async function runDeltaLedgerSyncForUsers(
  prisma: PrismaClient,
  opts?: { userId?: string },
): Promise<Record<string, IngestDeltaLedgerResult>> {
  let users = await listEligibleDeltaLedgerUsers(prisma);
  if (opts?.userId) {
    users = users.filter((u) => u.userId === opts.userId);
  }

  const summary: DeltaLedgerCycleSummary = {
    users: users.length,
    inserted: 0,
    skipped: 0,
    conflicts: 0,
    lateRows: 0,
  };

  const results: Record<string, IngestDeltaLedgerResult> = {};
  for (const user of users) {
    try {
      const result = await syncOneEligibleUser(prisma, user);
      results[user.userId] = result;
      mergeIntoCycleSummary(summary, result);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[DeltaLedger] sync failed user=${user.userId}: ${msg}`);
      results[user.userId] = emptyIngestResult();
    }
  }

  logDeltaLedgerCycleSummary(summary);
  return results;
}

/** Re-fetch last N days for all eligible users (idempotent via deltaUuid). */
export async function runDeltaLedgerDeepSweep(
  prisma: PrismaClient,
): Promise<DeltaLedgerCycleSummary> {
  const users = await listEligibleDeltaLedgerUsers(prisma);
  const since = resolveDeltaLedgerDeepSweepSince();

  const summary: DeltaLedgerCycleSummary = {
    users: users.length,
    inserted: 0,
    skipped: 0,
    conflicts: 0,
    lateRows: 0,
  };

  console.log(
    `[DeltaLedger] deep sweep start users=${users.length} since=${since.toISOString()} ` +
      `days=${deepSweepDays()}`,
  );

  for (const user of users) {
    try {
      const result = await syncOneEligibleUser(prisma, user, {
        since,
        deepSweep: true,
        advanceCursor: false,
      });
      mergeIntoCycleSummary(summary, result);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[DeltaLedger] deep sweep failed user=${user.userId}: ${msg}`);
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
  cron.schedule(
    "*/5 * * * *",
    () => {
      void runDeltaLedgerSyncCycle(prisma).catch((err) => {
        console.error("[DeltaLedger] Scheduled sync cycle failed:", err);
      });
    },
    { timezone: "Etc/UTC" },
  );

  cron.schedule(
    "30 2 * * *",
    () => {
      void runDeltaLedgerDeepSweep(prisma).catch((err) => {
        console.error("[DeltaLedger] Scheduled deep sweep failed:", err);
      });
    },
    { timezone: BILLING_TIMEZONE },
  );

  console.log(
    `[DeltaLedger] Scheduled wallet sync every 5 min UTC; deep sweep @ 02:30 IST ` +
      `(overlap=${syncOverlapHours()}h, sweep=${deepSweepDays()}d)`,
  );
}
