import { Prisma, type PrismaClient } from "@prisma/client";
import cron from "node-cron";
import { decryptDeltaSecretOrPlain } from "../utils/encryption.js";
import { fetchDeltaWalletTransactionsPage } from "./exchangeService.js";

const WALLET_TX_PAGE_SIZE = "100";
const WALLET_TX_MAX_PAGES = 500;
const SYNC_OVERLAP_MS = 10 * 60 * 1000;
const DEFAULT_LOOKBACK_MS = 90 * 24 * 60 * 60 * 1000;

export type IngestDeltaLedgerResult = {
  inserted: number;
  skipped: number;
  lastOccurredAt: Date | null;
};

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

/** Earliest fetch window — overlap prior cursor by 10 minutes when set. */
export function resolveDeltaLedgerSyncSince(
  syncedUpTo: Date | null | undefined,
): Date {
  if (syncedUpTo instanceof Date && !Number.isNaN(syncedUpTo.getTime())) {
    return new Date(syncedUpTo.getTime() - SYNC_OVERLAP_MS);
  }
  return new Date(Date.now() - DEFAULT_LOOKBACK_MS);
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

/**
 * Ingest Delta wallet transactions for one user from `since` forward.
 * Rows are keyed on (userId, deltaUuid) — safe to retry; existing rows are never updated.
 */
export async function ingestDeltaLedgerForUser(
  prisma: PrismaClient,
  args: {
    userId: string;
    apiKey: string;
    apiSecret: string;
    since: Date;
  },
): Promise<IngestDeltaLedgerResult> {
  const rows = await fetchAllWalletTransactionsSince(
    args.apiKey,
    args.apiSecret,
    args.since,
  );

  let inserted = 0;
  let skipped = 0;
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
        console.warn(
          `[DeltaLedger] CONFLICT user=${args.userId} uuid=${deltaUuid} ` +
            `stored=${existing.amount.toFixed(10)} incoming=${amount.toFixed(10)}`,
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
  }

  return { inserted, skipped, lastOccurredAt };
}

type EligibleLedgerUser = {
  userId: string;
  apiKeyStored: string;
  apiSecretStored: string;
  syncedUpTo: Date | null;
};

async function listEligibleDeltaLedgerUsers(
  prisma: PrismaClient,
): Promise<EligibleLedgerUser[]> {
  const subs = await prisma.userStrategySubscription.findMany({
    where: {
      isActive: true,
      exchangeAccountId: { not: null },
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
        select: { id: true, deltaLedgerSyncedUpTo: true },
      },
    },
  });

  const byUser = new Map<string, EligibleLedgerUser>();
  for (const sub of subs) {
    if (!sub.exchangeAccount) continue;
    if (byUser.has(sub.userId)) continue;
    byUser.set(sub.userId, {
      userId: sub.userId,
      apiKeyStored: sub.exchangeAccount.apiKey,
      apiSecretStored: sub.exchangeAccount.apiSecret,
      syncedUpTo: sub.user.deltaLedgerSyncedUpTo,
    });
  }
  return [...byUser.values()];
}

async function runDeltaLedgerSyncCycle(prisma: PrismaClient): Promise<void> {
  const users = await listEligibleDeltaLedgerUsers(prisma);
  if (users.length === 0) return;

  for (const user of users) {
    try {
      const since = resolveDeltaLedgerSyncSince(user.syncedUpTo);
      const apiKey = decryptDeltaSecretOrPlain(user.apiKeyStored);
      const apiSecret = decryptDeltaSecretOrPlain(user.apiSecretStored);

      const result = await ingestDeltaLedgerForUser(prisma, {
        userId: user.userId,
        apiKey,
        apiSecret,
        since,
      });

      if (result.lastOccurredAt) {
        const prior = user.syncedUpTo;
        const next =
          prior && prior > result.lastOccurredAt ? prior : result.lastOccurredAt;
        await prisma.user.update({
          where: { id: user.userId },
          data: { deltaLedgerSyncedUpTo: next },
        });
      }

      console.log(
        `[DeltaLedger] user=${user.userId} inserted=${result.inserted} ` +
          `skipped=${result.skipped} upTo=${result.lastOccurredAt?.toISOString() ?? "n/a"}`,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[DeltaLedger] sync failed user=${user.userId}: ${msg}`);
    }
  }
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
  console.log("[DeltaLedger] Scheduled wallet transaction sync (every 5 min UTC)");
}
