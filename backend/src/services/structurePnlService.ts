import { Prisma, type PrismaClient } from "@prisma/client";

const BOT_BASE_URL = "http://127.0.0.1:8000";
const BOT_TIMEOUT_MS = 10_000;
/** Grace after leg close — Delta may book commission slightly after the fill. */
export const LEG_CLOSE_GRACE_MS = 60_000;

const BILLING_TXN_TYPES = new Set(["cashflow", "commission"]);

type BotLeg = {
  botLegId: number;
  legRole: string;
  basketSeq: number | null;
  adjSeq: number | null;
  productId: number;
  symbol: string | null;
  strike: number | null;
  side: string;
  quantity: number;
  openedAt: Date;
  closedAt: Date | null;
};

type BotStructure = {
  botStructureId: number;
  hedgePositionId: number;
  underlying: string;
  status: string;
  openedAt: Date;
  closedAt: Date | null;
  closeReason: string | null;
  legs: BotLeg[];
};

type LedgerRow = {
  deltaUuid: string;
  productId: number | null;
  transactionType: string;
  amount: Prisma.Decimal;
  occurredAt: Date;
};

type LegRef = {
  structure: BotStructure;
  leg: BotLeg;
};

function legKey(structureId: number, botLegId: number): string {
  return `${structureId}:${botLegId}`;
}

export type StructurePnlUserResult = {
  structures: number;
  closed: number;
  realizedTotal: number;
  unmatchedTxns: number;
};

function numberOrNull(value: unknown): number | null {
  if (value === undefined || value === null) return null;
  const n = typeof value === "number" ? value : parseFloat(String(value));
  return Number.isFinite(n) ? n : null;
}

function parseDate(value: unknown): Date | null {
  if (typeof value === "string") {
    const d = new Date(value);
    if (!Number.isNaN(d.getTime())) return d;
  }
  const n = numberOrNull(value);
  if (n === null) return null;
  if (n > 1e12) return new Date(n);
  if (n > 1e9) return new Date(n * 1000);
  return null;
}

function zeroDecimal(): Prisma.Decimal {
  return new Prisma.Decimal(0);
}

async function botFetch(
  path: string,
  options: RequestInit = {},
): Promise<{ ok: boolean; status: number; data: unknown }> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), BOT_TIMEOUT_MS);
    const res = await fetch(`${BOT_BASE_URL}${path}`, {
      ...options,
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        ...(options.headers ?? {}),
      },
    });
    clearTimeout(timer);
    let data: unknown = null;
    try {
      data = await res.json();
    } catch {
      data = null;
    }
    return { ok: res.ok, status: res.status, data };
  } catch (err) {
    console.error(`[StructurePnl] bot fetch ${path} failed:`, err);
    return { ok: false, status: 0, data: null };
  }
}

function parseBotLeg(raw: Record<string, unknown>): BotLeg | null {
  const botLegId = numberOrNull(raw.id ?? raw.leg_id ?? raw.bot_leg_id);
  const productId = numberOrNull(raw.product_id);
  const openedAt = parseDate(raw.opened_at);
  if (botLegId === null || productId === null || !openedAt) return null;

  const closedAtRaw = parseDate(raw.closed_at);
  const basketSeq = numberOrNull(raw.basket_seq);
  const adjSeq = numberOrNull(raw.adj_seq);
  const quantity = numberOrNull(raw.quantity) ?? 0;

  return {
    botLegId: Math.trunc(botLegId),
    legRole: String(raw.leg_role ?? raw.role ?? "unknown"),
    basketSeq: basketSeq != null ? Math.trunc(basketSeq) : null,
    adjSeq: adjSeq != null ? Math.trunc(adjSeq) : null,
    productId: Math.trunc(productId),
    symbol:
      typeof raw.symbol === "string" && raw.symbol.trim().length > 0
        ? raw.symbol.trim()
        : null,
    strike: numberOrNull(raw.strike),
    side: String(raw.side ?? "unknown"),
    quantity: Math.trunc(quantity),
    openedAt,
    closedAt: closedAtRaw,
  };
}

function parseBotStructure(raw: Record<string, unknown>): BotStructure | null {
  const botStructureId = numberOrNull(raw.id ?? raw.structure_id ?? raw.bot_structure_id);
  const hedgePositionId = numberOrNull(
    raw.hedge_position_id ?? raw.hedgePositionId,
  );
  const openedAt = parseDate(raw.opened_at);
  if (botStructureId === null || hedgePositionId === null || !openedAt) {
    return null;
  }

  const legsRaw = Array.isArray(raw.legs) ? raw.legs : [];
  const legs: BotLeg[] = [];
  for (const item of legsRaw) {
    if (item == null || typeof item !== "object") continue;
    const leg = parseBotLeg(item as Record<string, unknown>);
    if (leg) legs.push(leg);
  }

  return {
    botStructureId: Math.trunc(botStructureId),
    hedgePositionId: Math.trunc(hedgePositionId),
    underlying: String(raw.underlying ?? "BTC"),
    status: String(raw.status ?? "active").toLowerCase(),
    openedAt,
    closedAt: parseDate(raw.closed_at),
    closeReason:
      typeof raw.close_reason === "string" ? raw.close_reason : null,
    legs,
  };
}

async function fetchBotStructures(userId: string): Promise<BotStructure[]> {
  const result = await botFetch(
    `/api/structures?earner_user_id=${encodeURIComponent(userId)}`,
    { method: "GET" },
  );
  if (!result.ok || result.data == null) return [];

  const payload = result.data;
  const rows = Array.isArray(payload)
    ? payload
    : Array.isArray((payload as Record<string, unknown>).structures)
      ? ((payload as Record<string, unknown>).structures as unknown[])
      : [];

  const structures: BotStructure[] = [];
  for (const row of rows) {
    if (row == null || typeof row !== "object") continue;
    const parsed = parseBotStructure(row as Record<string, unknown>);
    if (parsed) structures.push(parsed);
  }
  return structures;
}

function legWindowUpper(leg: BotLeg): Date | null {
  if (!leg.closedAt) return null;
  return new Date(leg.closedAt.getTime() + LEG_CLOSE_GRACE_MS);
}

function txnMatchesLeg(txn: LedgerRow, leg: BotLeg): boolean {
  if (txn.productId !== leg.productId) return false;
  if (txn.occurredAt < leg.openedAt) return false;
  const upper = legWindowUpper(leg);
  if (upper && txn.occurredAt > upper) return false;
  return true;
}

function isBillingTxnType(transactionType: string): boolean {
  return BILLING_TXN_TYPES.has(transactionType.toLowerCase());
}

type LegTotals = {
  grossCashflow: Prisma.Decimal;
  commissionTotal: Prisma.Decimal;
  matchedTxnCount: number;
};

function emptyLegTotals(): LegTotals {
  return {
    grossCashflow: zeroDecimal(),
    commissionTotal: zeroDecimal(),
    matchedTxnCount: 0,
  };
}

function applyTxnToLegTotals(totals: LegTotals, txn: LedgerRow): void {
  totals.matchedTxnCount += 1;
  const tt = txn.transactionType.toLowerCase();
  if (tt === "cashflow") {
    totals.grossCashflow = totals.grossCashflow.add(txn.amount);
  } else if (tt === "commission") {
    totals.commissionTotal = totals.commissionTotal.add(txn.amount);
  }
}

function legRealizedPnl(totals: LegTotals, leg: BotLeg): Prisma.Decimal | null {
  if (!leg.closedAt) return null;
  return totals.grossCashflow.add(totals.commissionTotal);
}

async function listEligibleStructurePnlUserIds(
  prisma: PrismaClient,
): Promise<string[]> {
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
    select: { userId: true },
    distinct: ["userId"],
  });
  return subs.map((s) => s.userId);
}

async function loadBillingLedgerRows(
  prisma: PrismaClient,
  userId: string,
): Promise<LedgerRow[]> {
  const rows = await prisma.deltaLedgerEntry.findMany({
    where: {
      userId,
      transactionType: { in: [...BILLING_TXN_TYPES] },
    },
    orderBy: { occurredAt: "asc" },
  });

  return rows.map((row) => ({
    deltaUuid: row.deltaUuid,
    productId: row.productId,
    transactionType: row.transactionType,
    amount: row.amount,
    occurredAt: row.occurredAt,
  }));
}

async function recomputeStructurePnlForUser(
  prisma: PrismaClient,
  userId: string,
): Promise<StructurePnlUserResult> {
  const structures = await fetchBotStructures(userId);
  const ledgerRows = await loadBillingLedgerRows(prisma, userId);

  const allLegRefs: LegRef[] = [];
  for (const structure of structures) {
    for (const leg of structure.legs) {
      allLegRefs.push({ structure, leg });
    }
  }

  const legTotals = new Map<string, LegTotals>();
  for (const ref of allLegRefs) {
    legTotals.set(
      legKey(ref.structure.botStructureId, ref.leg.botLegId),
      emptyLegTotals(),
    );
  }

  const unmatched: LedgerRow[] = [];
  let matchedTxnCount = 0;

  for (const txn of ledgerRows) {
    if (txn.productId == null) continue;

    const matching = allLegRefs.filter((ref) => txnMatchesLeg(txn, ref.leg));
    if (matching.length === 0) {
      unmatched.push(txn);
      continue;
    }

    if (matching.length > 1) {
      console.error(
        `[StructurePnl] OVERLAP user=${userId} uuid=${txn.deltaUuid} ` +
          `legs=[${matching.map((m) => m.leg.botLegId).join(",")}]`,
      );
    }

    matching.sort((a, b) => a.leg.botLegId - b.leg.botLegId);
    const chosen = matching[0]!;
    const key = legKey(chosen.structure.botStructureId, chosen.leg.botLegId);
    const totals = legTotals.get(key)!;
    applyTxnToLegTotals(totals, txn);
    matchedTxnCount += 1;
  }

  const unmatchedAmount = unmatched.reduce(
    (sum, row) => sum.add(row.amount),
    zeroDecimal(),
  );

  let closedStructures = 0;
  let realizedTotal = 0;
  const computedAt = new Date();

  for (const structure of structures) {
    let structGross = zeroDecimal();
    let structCommission = zeroDecimal();
    let structMatched = 0;
    let closedLegCount = 0;

    const structureRow = await prisma.structurePnl.upsert({
      where: {
        userId_botStructureId: {
          userId,
          botStructureId: structure.botStructureId,
        },
      },
      create: {
        userId,
        botStructureId: structure.botStructureId,
        hedgePositionId: structure.hedgePositionId,
        underlying: structure.underlying,
        status: structure.status,
        openedAt: structure.openedAt,
        closedAt: structure.closedAt,
        closeReason: structure.closeReason,
        grossCashflow: zeroDecimal(),
        commissionTotal: zeroDecimal(),
        realizedPnl: null,
        legCount: structure.legs.length,
        closedLegCount: 0,
        matchedTxnCount: 0,
        computedAt,
      },
      update: {
        hedgePositionId: structure.hedgePositionId,
        underlying: structure.underlying,
        status: structure.status,
        openedAt: structure.openedAt,
        closedAt: structure.closedAt,
        closeReason: structure.closeReason,
        legCount: structure.legs.length,
        computedAt,
      },
    });

    for (const leg of structure.legs) {
      const totals =
        legTotals.get(legKey(structure.botStructureId, leg.botLegId)) ??
        emptyLegTotals();
      structGross = structGross.add(totals.grossCashflow);
      structCommission = structCommission.add(totals.commissionTotal);
      structMatched += totals.matchedTxnCount;
      if (leg.closedAt) closedLegCount += 1;

      const legRealized = legRealizedPnl(totals, leg);

      await prisma.structureLegPnl.upsert({
        where: {
          structurePnlId_botLegId: {
            structurePnlId: structureRow.id,
            botLegId: leg.botLegId,
          },
        },
        create: {
          structurePnlId: structureRow.id,
          botLegId: leg.botLegId,
          legRole: leg.legRole,
          basketSeq: leg.basketSeq,
          adjSeq: leg.adjSeq,
          productId: leg.productId,
          symbol: leg.symbol,
          strike: leg.strike,
          side: leg.side,
          quantity: leg.quantity,
          openedAt: leg.openedAt,
          closedAt: leg.closedAt,
          grossCashflow: totals.grossCashflow,
          commissionTotal: totals.commissionTotal,
          realizedPnl: legRealized,
          matchedTxnCount: totals.matchedTxnCount,
        },
        update: {
          legRole: leg.legRole,
          basketSeq: leg.basketSeq,
          adjSeq: leg.adjSeq,
          productId: leg.productId,
          symbol: leg.symbol,
          strike: leg.strike,
          side: leg.side,
          quantity: leg.quantity,
          openedAt: leg.openedAt,
          closedAt: leg.closedAt,
          grossCashflow: totals.grossCashflow,
          commissionTotal: totals.commissionTotal,
          realizedPnl: legRealized,
          matchedTxnCount: totals.matchedTxnCount,
        },
      });
    }

    const allLegsClosed =
      structure.legs.length > 0 &&
      structure.legs.every((leg) => leg.closedAt != null);
    const structureRealized =
      structure.status === "closed" && allLegsClosed
        ? structGross.add(structCommission)
        : null;

    if (structureRealized != null) {
      closedStructures += 1;
      realizedTotal += structureRealized.toNumber();
    }

    await prisma.structurePnl.update({
      where: { id: structureRow.id },
      data: {
        grossCashflow: structGross,
        commissionTotal: structCommission,
        realizedPnl: structureRealized,
        closedLegCount,
        matchedTxnCount: structMatched,
        computedAt,
      },
    });
  }

  console.log(
    `[StructurePnl] user=${userId} structures=${structures.length} ` +
      `matched_txns=${matchedTxnCount} unmatched_txns=${unmatched.length} ` +
      `unmatched_amount=${unmatchedAmount.toFixed(10)}`,
  );

  return {
    structures: structures.length,
    closed: closedStructures,
    realizedTotal,
    unmatchedTxns: unmatched.length,
  };
}

/** Recompute structure P&L from Delta ledger for eligible bot-strategy users. */
export async function recomputeStructurePnlForUsers(
  prisma: PrismaClient,
  opts?: { userId?: string },
): Promise<Record<string, StructurePnlUserResult>> {
  let userIds = await listEligibleStructurePnlUserIds(prisma);
  if (opts?.userId) {
    userIds = userIds.filter((id) => id === opts.userId);
  }

  const results: Record<string, StructurePnlUserResult> = {};
  for (const userId of userIds) {
    try {
      results[userId] = await recomputeStructurePnlForUser(prisma, userId);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[StructurePnl] recompute failed user=${userId}: ${msg}`);
      results[userId] = {
        structures: 0,
        closed: 0,
        realizedTotal: 0,
        unmatchedTxns: 0,
      };
    }
  }
  return results;
}
