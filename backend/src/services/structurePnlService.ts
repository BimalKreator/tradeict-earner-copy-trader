import { Prisma, type PrismaClient } from "@prisma/client";
import { excludeSimulatedFilter } from "./simulatedDataFilters.js";

const BOT_BASE_URL = "http://127.0.0.1:8000";
const BOT_TIMEOUT_MS = 10_000;
/** Grace after leg close — Delta may book commission slightly after the fill. */
export const LEG_CLOSE_GRACE_MS = 60_000;

export const ATTRIBUTION_STATUS = {
  OK: "OK",
  SUSPECT_INCOMPLETE: "SUSPECT_INCOMPLETE",
} as const;

export type AttributionStatus =
  (typeof ATTRIBUTION_STATUS)[keyof typeof ATTRIBUTION_STATUS];

/**
 * Minimum matched txns when the leg closed via settlement (ITM expiry),
 * not a trade exit — settlement alone is enough evidence of close.
 */
const MIN_SETTLEMENT_CLOSED_MATCHED_TXNS = 1;

/**
 * Ledger transaction types that count toward customer structure P&L.
 * - cashflow: option/perp trade premiums and trade cashflows
 * - commission: exchange trading fees (customer cost)
 * - funding: perpetual futures funding payments — this strategy runs a
 *   futures hedge, so funding is paid from the customer’s wallet
 * - settlement: ITM option expiry settlement (not a trade fill)
 * - liquidation_fee: cost of liquidation events
 * Deposits, withdrawals, and sub_account_transfer stay excluded.
 */
export const BILLING_TXN_TYPES = new Set([
  "cashflow",
  "commission",
  "funding",
  "settlement",
  "liquidation_fee",
]);

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
  /** Explicit bot override; null means use openedAt for window start. */
  attributionFrom: Date | null;
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
  /** Bot-side attribution warning — treated as SUSPECT_INCOMPLETE. */
  attributionWarning: string | null;
};

type LedgerRow = {
  deltaUuid: string;
  productId: number | null;
  transactionType: string;
  amount: Prisma.Decimal;
  occurredAt: Date;
  metaJson: unknown;
};

/** Per-leg attribution window inputs — shared by P&L recompute, health, and invoices. */
export type LegWindowSpec = {
  botStructureId: number;
  botLegId: number;
  productId: number;
  openedAt: Date;
  attributionFrom: Date | null;
  closedAt: Date | null;
};

/**
 * Delta wallet ledger metaJson keys observed in ingest (product_symbol via
 * deltaLedgerService). Official API schema documents meta_data as an empty
 * object for wallet transactions — no order_id / fill_id on ledger rows.
 * Fills carry order_id in a separate API; bot legs do not expose order ids.
 */
export function extractOrderRefFromLedgerMeta(metaJson: unknown): string | null {
  if (metaJson == null || typeof metaJson !== "object" || Array.isArray(metaJson)) {
    return null;
  }
  const m = metaJson as Record<string, unknown>;
  for (const key of [
    "order_id",
    "orderId",
    "fill_id",
    "fillId",
    "client_order_id",
    "clientOrderId",
  ]) {
    const v = m[key];
    if (v != null && String(v).trim().length > 0) return String(v).trim();
  }
  return null;
}

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
  const attributionFrom = parseDate(raw.attribution_from);
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
    attributionFrom,
    closedAt: closedAtRaw,
  };
}


function parseAttributionWarning(raw: Record<string, unknown>): string | null {
  const v = raw.attribution_warning ?? raw.attributionWarning;
  if (typeof v === "string" && v.trim().length > 0) return v.trim();
  return null;
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
    attributionWarning: parseAttributionWarning(raw),
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

function isSameLeg(a: LegWindowSpec, b: LegWindowSpec): boolean {
  return a.botStructureId === b.botStructureId && a.botLegId === b.botLegId;
}

/** Whether leg L's window contains txn at all (full grace — used to detect other legs open at txn). */
export function isLegOpenAtTxn(
  leg: LegWindowSpec,
  txnOccurredAt: Date,
): boolean {
  if (txnOccurredAt < resolveLegAttributionWindowStart(leg)) return false;
  if (!leg.closedAt) return true;
  const endWithGrace = leg.closedAt.getTime() + LEG_CLOSE_GRACE_MS;
  return txnOccurredAt.getTime() <= endWithGrace;
}

/**
 * Upper bound of leg L's attribution window for a specific txn.
 * Grace is suppressed only when another leg on the same product is actually
 * open at txn.occurredAt — not merely because another leg existed earlier.
 */
export function resolveLegWindowEndForTxn(
  leg: LegWindowSpec,
  productLegs: LegWindowSpec[],
  txnOccurredAt: Date,
): Date | null {
  if (!leg.closedAt) return null;
  const anotherLegOpenAtTxn = productLegs.some(
    (other) =>
      !isSameLeg(other, leg) &&
      other.productId === leg.productId &&
      isLegOpenAtTxn(other, txnOccurredAt),
  );
  const graceMs = anotherLegOpenAtTxn ? 0 : LEG_CLOSE_GRACE_MS;
  return new Date(leg.closedAt.getTime() + graceMs);
}

/** @deprecated Prefer resolveLegWindowEndForTxn — grace depends on txn time. */
export function resolveLegWindowEnd(
  leg: LegWindowSpec,
  _productLegs: LegWindowSpec[],
): Date | null {
  if (!leg.closedAt) return null;
  return new Date(leg.closedAt.getTime() + LEG_CLOSE_GRACE_MS);
}

export function txnMatchesLegWindowSpec(
  txn: { productId: number | null; occurredAt: Date },
  leg: LegWindowSpec,
  productLegs: LegWindowSpec[],
): boolean {
  if (txn.productId !== leg.productId) return false;
  if (txn.occurredAt < resolveLegAttributionWindowStart(leg)) return false;
  const upper = resolveLegWindowEndForTxn(leg, productLegs, txn.occurredAt);
  if (upper && txn.occurredAt > upper) return false;
  return true;
}

/** All legs whose product + time window contains this txn (may be 0, 1, or many). */
export function findMatchingLegWindows(
  txn: { productId: number | null; occurredAt: Date },
  legs: LegWindowSpec[],
): LegWindowSpec[] {
  if (txn.productId == null) return [];
  const productLegs = legs.filter((l) => l.productId === txn.productId);
  return legs.filter((l) => txnMatchesLegWindowSpec(txn, l, productLegs));
}

/** Real open window (no grace): attributionFrom/openedAt .. closedAt inclusive. */
export function isTxnInRealWindow(
  leg: LegWindowSpec,
  at: Date,
): boolean {
  if (at < resolveLegAttributionWindowStart(leg)) return false;
  if (!leg.closedAt) return true;
  return at.getTime() <= leg.closedAt.getTime();
}

/**
 * Chronological grace after close — independent of a979b8c grace suppression.
 * Used to detect the silent-award case: txn in A's grace and B's real window.
 */
export function isTxnInChronologicalGrace(
  leg: LegWindowSpec,
  at: Date,
): boolean {
  if (!leg.closedAt) return false;
  const t = at.getTime();
  const close = leg.closedAt.getTime();
  return t > close && t <= close + LEG_CLOSE_GRACE_MS;
}

/**
 * When findMatchingLegWindows returns a unique winner (typically B's real
 * window), return other same-product legs that still chronologically cover
 * the txn via grace. Non-empty ⇒ ambiguous — do not assign silently (15.4).
 */
export function findGraceVsRealAmbiguityPartners(
  txn: { productId: number | null; occurredAt: Date },
  awardedLeg: LegWindowSpec,
  allLegs: LegWindowSpec[],
): LegWindowSpec[] {
  if (txn.productId == null) return [];
  if (!isTxnInRealWindow(awardedLeg, txn.occurredAt)) return [];
  return allLegs.filter(
    (leg) =>
      !isSameLeg(leg, awardedLeg) &&
      leg.productId === txn.productId &&
      isTxnInChronologicalGrace(leg, txn.occurredAt),
  );
}

function legRefToWindowSpec(ref: LegRef): LegWindowSpec {
  return {
    botStructureId: ref.structure.botStructureId,
    botLegId: ref.leg.botLegId,
    productId: ref.leg.productId,
    openedAt: ref.leg.openedAt,
    attributionFrom: ref.leg.attributionFrom,
    closedAt: ref.leg.closedAt,
  };
}

function isBillingTxnType(transactionType: string): boolean {
  return BILLING_TXN_TYPES.has(transactionType.toLowerCase());
}

type LegTotals = {
  grossCashflow: Prisma.Decimal;
  commissionTotal: Prisma.Decimal;
  fundingTotal: Prisma.Decimal;
  settlementTotal: Prisma.Decimal;
  liquidationFeeTotal: Prisma.Decimal;
  matchedTxnCount: number;
  cashflowCount: number;
  commissionCount: number;
  cashflowHasPositive: boolean;
  cashflowHasNegative: boolean;
  /** True when at least one settlement row was attributed to this leg. */
  hasSettlement: boolean;
  /** Overlap with another leg's window — txn was not guessed onto either leg. */
  overlapConflict: boolean;
  /** Max leg count from any overlap event affecting this leg. */
  overlapLegCount: number;
  /**
   * Ambiguous: txn sits in this leg's chronological grace and another leg's
   * real window — not silently assigned (15.4).
   */
  graceAmbiguity: boolean;
};

function emptyLegTotals(): LegTotals {
  return {
    grossCashflow: zeroDecimal(),
    commissionTotal: zeroDecimal(),
    fundingTotal: zeroDecimal(),
    settlementTotal: zeroDecimal(),
    liquidationFeeTotal: zeroDecimal(),
    matchedTxnCount: 0,
    cashflowCount: 0,
    commissionCount: 0,
    cashflowHasPositive: false,
    cashflowHasNegative: false,
    hasSettlement: false,
    overlapConflict: false,
    overlapLegCount: 0,
    graceAmbiguity: false,
  };
}

function applyTxnToLegTotals(totals: LegTotals, txn: LedgerRow): void {
  totals.matchedTxnCount += 1;
  const tt = txn.transactionType.toLowerCase();
  if (tt === "cashflow") {
    totals.grossCashflow = totals.grossCashflow.add(txn.amount);
    totals.cashflowCount += 1;
    if (txn.amount.greaterThan(0)) totals.cashflowHasPositive = true;
    if (txn.amount.lessThan(0)) totals.cashflowHasNegative = true;
  } else if (tt === "commission") {
    totals.commissionTotal = totals.commissionTotal.add(txn.amount);
    totals.commissionCount += 1;
  } else if (tt === "funding") {
    totals.fundingTotal = totals.fundingTotal.add(txn.amount);
  } else if (tt === "settlement") {
    totals.settlementTotal = totals.settlementTotal.add(txn.amount);
    totals.hasSettlement = true;
  } else if (tt === "liquidation_fee") {
    totals.liquidationFeeTotal = totals.liquidationFeeTotal.add(txn.amount);
  }
}

function legRealizedPnl(totals: LegTotals, leg: BotLeg): Prisma.Decimal | null {
  if (!leg.closedAt) return null;
  // Delta costs arrive as negative amounts — .add() is correct (same as commission).
  return totals.grossCashflow
    .add(totals.commissionTotal)
    .add(totals.fundingTotal)
    .add(totals.settlementTotal)
    .add(totals.liquidationFeeTotal);
}

export type LegAttributionWindow = {
  productId: number;
  botLegId?: number;
  /** Window start — use attributionFrom when set, else openedAt. */
  attributionFrom: Date;
  closedAt: Date | null;
};

/** Whether a ledger row falls inside a leg's product + time attribution window. */
export function ledgerTxnMatchesLegWindow(
  txn: { productId: number | null; occurredAt: Date },
  leg: LegAttributionWindow,
  allLegs?: LegWindowSpec[],
): boolean {
  const spec: LegWindowSpec = {
    botStructureId: 0,
    botLegId: leg.botLegId ?? -1,
    productId: leg.productId,
    openedAt: leg.attributionFrom,
    attributionFrom: leg.attributionFrom,
    closedAt: leg.closedAt,
  };
  const productLegs =
    allLegs?.filter((l) => l.productId === leg.productId) ?? [spec];
  return txnMatchesLegWindowSpec(txn, spec, productLegs);
}

export function resolveLegAttributionWindowStart(leg: {
  openedAt: Date;
  attributionFrom?: Date | null;
}): Date {
  return leg.attributionFrom ?? leg.openedAt;
}

type LegAttributionFailure = {
  botLegId: number;
  matchedTxnCount: number;
  reason: string;
  /** Commission shortfall count (cashflows without a paired commission). */
  missingCommissionCount?: number;
};

/**
 * Structural completeness for a closed trade-exit leg: every cashflow fill
 * must have its paired commission. Row-count thresholds are not used — a
 * multi-fill leg can exceed any numeric minimum while still missing a fee.
 * Keep hasBothCashflowSigns — that catches a different failure mode.
 */
export function evaluateLegStructuralCompleteness(totals: {
  cashflowCount: number;
  commissionCount: number;
  cashflowHasPositive: boolean;
  cashflowHasNegative: boolean;
  hasSettlement: boolean;
  matchedTxnCount: number;
  overlapConflict?: boolean;
  overlapLegCount?: number;
  graceAmbiguity?: boolean;
}): { ok: boolean; reason: string | null; missingCommissionCount: number } {
  if (totals.overlapConflict) {
    return {
      ok: false,
      reason: `overlap: txn matched ${totals.overlapLegCount ?? 0} legs`,
      missingCommissionCount: 0,
    };
  }
  if (totals.graceAmbiguity) {
    return {
      ok: false,
      reason:
        "grace/real ambiguity: txn in one leg's chronological grace and another's real window (not assigned)",
      missingCommissionCount: 0,
    };
  }

  // Settlement close: no entry+exit cashflow pair expected.
  if (totals.hasSettlement) {
    if (totals.matchedTxnCount < MIN_SETTLEMENT_CLOSED_MATCHED_TXNS) {
      return {
        ok: false,
        reason: `settlement-closed but matchedTxnCount < ${MIN_SETTLEMENT_CLOSED_MATCHED_TXNS}`,
        missingCommissionCount: 0,
      };
    }
    return { ok: true, reason: null, missingCommissionCount: 0 };
  }

  const hasBothCashflowSigns =
    totals.cashflowHasPositive && totals.cashflowHasNegative;
  if (!hasBothCashflowSigns) {
    return {
      ok: false,
      reason: "missing both cashflow signs (+ and -)",
      missingCommissionCount: 0,
    };
  }

  const missingCommissionCount = Math.max(
    0,
    totals.cashflowCount - totals.commissionCount,
  );
  if (missingCommissionCount > 0) {
    return {
      ok: false,
      reason: `commission shortfall: ${totals.cashflowCount} cashflow(s) but ${totals.commissionCount} commission(s) (missing ${missingCommissionCount})`,
      missingCommissionCount,
    };
  }

  return { ok: true, reason: null, missingCommissionCount: 0 };
}

function evaluateClosedLegAttribution(
  totals: LegTotals,
  leg: BotLeg,
): LegAttributionFailure | null {
  if (!leg.closedAt) return null;

  const result = evaluateLegStructuralCompleteness(totals);
  if (result.ok) return null;
  return {
    botLegId: leg.botLegId,
    matchedTxnCount: totals.matchedTxnCount,
    reason: result.reason ?? "incomplete",
    missingCommissionCount: result.missingCommissionCount,
  };
}

function evaluateStructureAttribution(
  structure: BotStructure,
  legTotals: Map<string, LegTotals>,
): { status: AttributionStatus | null; note: string | null } {
  if (structure.status !== "closed" || structure.legs.length === 0) {
    return { status: null, note: null };
  }

  const openLegs = structure.legs.filter((leg) => leg.closedAt == null);
  if (openLegs.length > 0) {
    const ids = openLegs.map((l) => l.botLegId).join(",");
    return {
      status: ATTRIBUTION_STATUS.SUSPECT_INCOMPLETE,
      note: `closed structure has open leg(s): [${ids}]`,
    };
  }

  const failures: LegAttributionFailure[] = [];
  for (const leg of structure.legs) {
    const totals =
      legTotals.get(legKey(structure.botStructureId, leg.botLegId)) ??
      emptyLegTotals();
    const failure = evaluateClosedLegAttribution(totals, leg);
    if (failure) failures.push(failure);
  }

  if (failures.length === 0) {
    return { status: ATTRIBUTION_STATUS.OK, note: null };
  }

  const note = failures
    .map((f) => {
      const missing =
        f.missingCommissionCount && f.missingCommissionCount > 0
          ? ` missingCommissions=${f.missingCommissionCount}`
          : "";
      return `leg ${f.botLegId}: ${f.reason} (matchedTxnCount=${f.matchedTxnCount}${missing})`;
    })
    .join("; ");
  return { status: ATTRIBUTION_STATUS.SUSPECT_INCOMPLETE, note };
}

/**
 * Eligibility must NOT read only StructurePnl — that table is created by
 * recomputeStructurePnlForUser, so a brand-new customer would never enter the
 * set (chicken-and-egg). Union existing rows with active bot-linked subs and
 * exchange accounts linked to a bot slave.
 */
export async function listEligibleStructurePnlUserIds(
  prisma: PrismaClient,
): Promise<string[]> {
  const [withRows, subs, accounts] = await Promise.all([
    prisma.structurePnl.findMany({
      where: {
        status: "closed",
        closedAt: { not: null },
      },
      select: { userId: true },
      distinct: ["userId"],
    }),
    prisma.userStrategySubscription.findMany({
      where: {
        isActive: true,
        botSlaveId: { not: null },
      },
      select: { userId: true },
      distinct: ["userId"],
    }),
    // ExchangeAccount has no botSlaveId; use accounts linked to a bot-linked sub.
    prisma.exchangeAccount.findMany({
      where: {
        subscriptions: { some: { botSlaveId: { not: null } } },
      },
      select: { userId: true },
      distinct: ["userId"],
    }),
  ]);

  const withRowsSet = new Set(withRows.map((r) => r.userId));
  const subsSet = new Set(subs.map((r) => r.userId));
  const accountsSet = new Set(accounts.map((r) => r.userId));
  const eligible = new Set([...withRowsSet, ...subsSet, ...accountsSet]);

  console.log(
    `[StructurePnl] eligible=${eligible.size} (withRows=${withRowsSet.size} subs=${subsSet.size} accounts=${accountsSet.size})`,
  );

  return [...eligible];
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
    metaJson: row.metaJson,
  }));
}

/** Count billing ledger rows in an IST window that match more than one leg window. */
export async function countBillingOverlapTxnsInIstWindow(
  prisma: PrismaClient,
  userId: string,
  windowStart: Date,
  windowEndExclusive: Date,
  isSimulated: boolean,
): Promise<number> {
  const simFilter = excludeSimulatedFilter(isSimulated);
  const [legs, ledgerRows] = await Promise.all([
    prisma.structureLegPnl.findMany({
      where: { structure: { userId, ...simFilter }, ...simFilter },
      select: {
        botLegId: true,
        productId: true,
        openedAt: true,
        attributionFrom: true,
        closedAt: true,
        structure: { select: { botStructureId: true } },
      },
    }),
    prisma.deltaLedgerEntry.findMany({
      where: {
        userId,
        transactionType: { in: [...BILLING_TXN_TYPES] },
        productId: { not: null },
        occurredAt: { gte: windowStart, lt: windowEndExclusive },
        ...simFilter,
      },
      select: { productId: true, occurredAt: true },
    }),
  ]);

  const specs: LegWindowSpec[] = legs.map((leg) => ({
    botStructureId: leg.structure.botStructureId,
    botLegId: leg.botLegId,
    productId: leg.productId,
    openedAt: leg.openedAt,
    attributionFrom: leg.attributionFrom,
    closedAt: leg.closedAt,
  }));

  let overlapTxnCount = 0;
  for (const txn of ledgerRows) {
    if (findMatchingLegWindows(txn, specs).length > 1) overlapTxnCount += 1;
  }
  return overlapTxnCount;
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

  const legWindowSpecs = allLegRefs.map(legRefToWindowSpec);
  const unmatched: LedgerRow[] = [];
  let matchedTxnCount = 0;
  /** Absolute amount of overlap-refused rows, keyed by botStructureId. */
  const droppedByStructure = new Map<number, Prisma.Decimal>();

  for (const txn of ledgerRows) {
    if (txn.productId == null) continue;

    const matchingSpecs = findMatchingLegWindows(txn, legWindowSpecs);
    if (matchingSpecs.length === 0) {
      unmatched.push(txn);
      continue;
    }

    if (matchingSpecs.length > 1) {
      const legIds = matchingSpecs.map((s) => s.botLegId);
      console.error(
        `[StructurePnl] OVERLAP user=${userId} uuid=${txn.deltaUuid} product=${txn.productId} ` +
          `legs=[${legIds.join(",")}] -- txn NOT counted, legs marked SUSPECT`,
      );
      const absAmt = txn.amount.abs();
      const touchedStructures = new Set(
        matchingSpecs.map((s) => s.botStructureId),
      );
      for (const botStructureId of touchedStructures) {
        const prev = droppedByStructure.get(botStructureId) ?? zeroDecimal();
        droppedByStructure.set(botStructureId, prev.add(absAmt));
      }
      for (const spec of matchingSpecs) {
        const key = legKey(spec.botStructureId, spec.botLegId);
        const totals = legTotals.get(key)!;
        totals.overlapConflict = true;
        totals.overlapLegCount = Math.max(
          totals.overlapLegCount,
          matchingSpecs.length,
        );
      }
      continue;
    }

    const spec = matchingSpecs[0]!;

    // 15.4 narrow rule: unique match under a979b8c, but another leg still has
    // this txn in chronological grace ⇒ ambiguous; record, do not assign.
    const gracePartners = findGraceVsRealAmbiguityPartners(
      txn,
      spec,
      legWindowSpecs,
    );
    if (gracePartners.length > 0) {
      const ambiguous = [spec, ...gracePartners];
      const legIds = ambiguous.map((s) => s.botLegId);
      console.error(
        `[StructurePnl] GRACE_AMBIGUITY user=${userId} uuid=${txn.deltaUuid} product=${txn.productId} ` +
          `legs=[${legIds.join(",")}] -- txn NOT counted, legs marked SUSPECT`,
      );
      const absAmt = txn.amount.abs();
      const touchedStructures = new Set(
        ambiguous.map((s) => s.botStructureId),
      );
      for (const botStructureId of touchedStructures) {
        const prev = droppedByStructure.get(botStructureId) ?? zeroDecimal();
        droppedByStructure.set(botStructureId, prev.add(absAmt));
      }
      for (const amb of ambiguous) {
        const key = legKey(amb.botStructureId, amb.botLegId);
        const totals = legTotals.get(key)!;
        totals.graceAmbiguity = true;
      }
      continue;
    }

    const key = legKey(spec.botStructureId, spec.botLegId);
    const totals = legTotals.get(key)!;
    applyTxnToLegTotals(totals, txn);
    matchedTxnCount += 1;
  }

  // 15.3: for legs short on commissions, claim unmatched same-product
  // commissions booked at/after close (often past grace) into dropped amount.
  const stillUnmatched: LedgerRow[] = [];
  const claimedUuids = new Set<string>();
  for (const ref of allLegRefs) {
    if (!ref.leg.closedAt) continue;
    const key = legKey(ref.structure.botStructureId, ref.leg.botLegId);
    const totals = legTotals.get(key)!;
    if (totals.hasSettlement) continue;
    const shortfall = Math.max(0, totals.cashflowCount - totals.commissionCount);
    if (shortfall <= 0) continue;

    const candidates = unmatched
      .filter(
        (row) =>
          !claimedUuids.has(row.deltaUuid) &&
          row.transactionType.toLowerCase() === "commission" &&
          row.productId === ref.leg.productId &&
          row.occurredAt.getTime() >= ref.leg.closedAt!.getTime(),
      )
      .sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime())
      .slice(0, shortfall);

    for (const row of candidates) {
      claimedUuids.add(row.deltaUuid);
      const prev =
        droppedByStructure.get(ref.structure.botStructureId) ?? zeroDecimal();
      droppedByStructure.set(
        ref.structure.botStructureId,
        prev.add(row.amount.abs()),
      );
    }
  }
  for (const row of unmatched) {
    if (!claimedUuids.has(row.deltaUuid)) stillUnmatched.push(row);
  }
  unmatched.length = 0;
  unmatched.push(...stillUnmatched);

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
    let structFunding = zeroDecimal();
    let structSettlement = zeroDecimal();
    let structLiquidationFee = zeroDecimal();
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
      structFunding = structFunding.add(totals.fundingTotal);
      structSettlement = structSettlement.add(totals.settlementTotal);
      structLiquidationFee = structLiquidationFee.add(
        totals.liquidationFeeTotal,
      );
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
          attributionFrom: leg.attributionFrom,
          closedAt: leg.closedAt,
          grossCashflow: totals.grossCashflow,
          commissionTotal: totals.commissionTotal,
          fundingTotal: totals.fundingTotal,
          settlementTotal: totals.settlementTotal,
          liquidationFeeTotal: totals.liquidationFeeTotal,
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
          attributionFrom: leg.attributionFrom,
          closedAt: leg.closedAt,
          grossCashflow: totals.grossCashflow,
          commissionTotal: totals.commissionTotal,
          fundingTotal: totals.fundingTotal,
          settlementTotal: totals.settlementTotal,
          liquidationFeeTotal: totals.liquidationFeeTotal,
          realizedPnl: legRealized,
          matchedTxnCount: totals.matchedTxnCount,
        },
      });
    }

    const allLegsClosed =
      structure.legs.length > 0 &&
      structure.legs.every((leg) => leg.closedAt != null);
    // Closed structures always get a realized figure (including stuck open-leg
    // cases). Open structures stay null. Never null-and-forget a closed loss.
    const structureRealized =
      structure.status === "closed"
        ? structGross
            .add(structCommission)
            .add(structFunding)
            .add(structSettlement)
            .add(structLiquidationFee)
        : null;

    if (structureRealized != null && allLegsClosed) {
      closedStructures += 1;
      realizedTotal += structureRealized.toNumber();
    }

    let attribution = evaluateStructureAttribution(structure, legTotals);
    if (structure.attributionWarning) {
      const warn = structure.attributionWarning;
      const note = attribution.note
        ? `${attribution.note}; bot attribution_warning: ${warn}`
        : `bot attribution_warning: ${warn}`;
      attribution = {
        status: ATTRIBUTION_STATUS.SUSPECT_INCOMPLETE,
        note,
      };
    }

    // Closed structures must always persist OK or SUSPECT — never NULL.
    const isClosedStructure = structure.status === "closed";
    const attributionStatus = isClosedStructure
      ? (attribution.status ?? ATTRIBUTION_STATUS.OK)
      : attribution.status;

    const droppedAbs =
      droppedByStructure.get(structure.botStructureId) ?? zeroDecimal();
    const attributionDroppedAmount = droppedAbs.greaterThan(0)
      ? droppedAbs
      : null;

    await prisma.structurePnl.update({
      where: { id: structureRow.id },
      data: {
        grossCashflow: structGross,
        commissionTotal: structCommission,
        realizedPnl: structureRealized,
        closedLegCount,
        matchedTxnCount: structMatched,
        computedAt,
        attributionStatus,
        attributionNote: attribution.note,
        attributionDroppedAmount,
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
  // Admin bootstrap: do not require the user to already be on the eligible list
  // (they may have no StructurePnl rows yet).
  const userIds = opts?.userId
    ? [opts.userId]
    : await listEligibleStructurePnlUserIds(prisma);

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
