/**
 * Iron-condor / basket wings support for Delta structure attribution.
 *
 * Bot structures may include BASKET_WING_* legs. When they do not (or leave
 * wings open after basket exit), Earner normalizes from the customer's ledger
 * so wing BUY cashflows are explained — not unmatched / dropped.
 */
import { Prisma } from "@prisma/client";

/** Wing entry must land within this skew of the basket shorts' opens. */
export const WING_ENTRY_MAX_SKEW_MS = 60_000;

export type StructureLegRole =
  | "BASKET_CALL"
  | "BASKET_PUT"
  | "BASKET_WING_CALL"
  | "BASKET_WING_PUT"
  | "HEDGE_CALL"
  | "HEDGE_PUT";

export const STRUCTURE_LEG_ROLE: { readonly [K in StructureLegRole]: K } = {
  BASKET_CALL: "BASKET_CALL",
  BASKET_PUT: "BASKET_PUT",
  BASKET_WING_CALL: "BASKET_WING_CALL",
  BASKET_WING_PUT: "BASKET_WING_PUT",
  HEDGE_CALL: "HEDGE_CALL",
  HEDGE_PUT: "HEDGE_PUT",
};

export type WingAwareLeg = {
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
  attributionFrom: Date | null;
  closedAt: Date | null;
};

export type WingAwareStructure = {
  botStructureId: number;
  status: string;
  openedAt: Date;
  closedAt: Date | null;
  legs: WingAwareLeg[];
};

export type WingLedgerHint = {
  productId: number | null;
  productSymbol: string | null;
  transactionType: string;
  amount: Prisma.Decimal;
  occurredAt: Date;
};

export function isWingLegRole(role: string): boolean {
  const r = role.trim().toUpperCase();
  return (
    r === STRUCTURE_LEG_ROLE.BASKET_WING_CALL ||
    r === STRUCTURE_LEG_ROLE.BASKET_WING_PUT ||
    r === "WING_CALL" ||
    r === "WING_PUT"
  );
}

export function isBasketShortRole(role: string): boolean {
  const r = role.trim().toUpperCase();
  return (
    r === STRUCTURE_LEG_ROLE.BASKET_CALL ||
    r === STRUCTURE_LEG_ROLE.BASKET_PUT ||
    r === "SHORT_CALL" ||
    r === "SHORT_PUT"
  );
}

export function isBasketSellSide(side: string): boolean {
  const s = side.trim().toLowerCase();
  return s === "sell" || s === "short";
}

export function isBasketBuySide(side: string): boolean {
  const s = side.trim().toLowerCase();
  return s === "buy" || s === "long";
}

/** Parse call/put from Delta-style symbols (C-BTC-… / P-BTC-… / …-C / …-P). */
export function optionKindFromSymbol(
  symbol: string | null | undefined,
): "call" | "put" | null {
  if (!symbol) return null;
  const s = symbol.trim().toUpperCase();
  if (!s) return null;
  const head = s.split("-")[0] ?? "";
  if (head === "C" || head === "CALL") return "call";
  if (head === "P" || head === "PUT") return "put";
  if (s.endsWith("-C") || s.endsWith("_C")) return "call";
  if (s.endsWith("-P") || s.endsWith("_P")) return "put";
  return null;
}

/**
 * Expiry token from option symbol for matching wings to shorts.
 * Examples: C-BTC-85000-040926 → 040926; BTC-85000-3SEP26-C → 3SEP26
 */
export function expiryKeyFromSymbol(
  symbol: string | null | undefined,
): string | null {
  if (!symbol) return null;
  const parts = symbol
    .trim()
    .toUpperCase()
    .split(/[-_]/)
    .filter(Boolean);
  if (parts.length < 3) return null;
  // Prefer trailing date-like token (has a digit).
  for (let i = parts.length - 1; i >= 0; i -= 1) {
    const tok = parts[i]!;
    if (tok === "C" || tok === "P" || tok === "CALL" || tok === "PUT") continue;
    if (tok === "BTC" || tok === "ETH") continue;
    if (/\d/.test(tok)) return tok;
  }
  return null;
}

export function syntheticWingBotLegId(productId: number): number {
  return -(1_000_000_000 + Math.trunc(productId));
}

/**
 * When the bot closes a basket but leaves BASKET_WING_* open, Earner heals
 * closedAt so attribution windows cover wing exit cashflows.
 */
export function healOpenWingLegsOnClosedStructure<T extends WingAwareStructure>(
  structure: T,
): T {
  if (structure.status.toLowerCase() !== "closed") return structure;
  const fallbackClosed =
    structure.closedAt ??
    structure.legs
      .filter((l) => isBasketShortRole(l.legRole) && l.closedAt != null)
      .map((l) => l.closedAt!.getTime())
      .reduce<number | null>(
        (max, t) => (max == null || t > max ? t : max),
        null,
      );

  if (fallbackClosed == null) return structure;

  const closedAt = new Date(fallbackClosed);
  let changed = false;
  const legs = structure.legs.map((leg) => {
    if (!isWingLegRole(leg.legRole) || leg.closedAt != null) return leg;
    changed = true;
    return { ...leg, closedAt };
  });
  return changed ? { ...structure, legs } : structure;
}

function productIdsInStructure(structure: WingAwareStructure): Set<number> {
  return new Set(structure.legs.map((l) => l.productId));
}

function shortLegs(structure: WingAwareStructure): WingAwareLeg[] {
  return structure.legs.filter(
    (l) => isBasketShortRole(l.legRole) || isBasketSellSide(l.side),
  );
}

function hasWingRole(structure: WingAwareStructure, role: string): boolean {
  const want = role.toUpperCase();
  return structure.legs.some((l) => l.legRole.trim().toUpperCase() === want);
}

function pickBasketSeq(structure: WingAwareStructure): number | null {
  const short = shortLegs(structure).find((l) => l.basketSeq != null);
  return short?.basketSeq ?? null;
}

/**
 * Discover optional BUY wing legs from ledger cashflows near short opens.
 * Same expiry token as shorts when symbols allow; entry within 60s.
 */
export function discoverWingLegsFromLedger<T extends WingAwareStructure>(
  structure: T,
  ledger: WingLedgerHint[],
): Omit<T, "legs"> & { legs: WingAwareLeg[] } {
  const shorts = shortLegs(structure).filter((l) =>
    isBasketShortRole(l.legRole),
  );
  if (shorts.length < 2) {
    return structure as Omit<T, "legs"> & { legs: WingAwareLeg[] };
  }

  const needCall = !hasWingRole(structure, STRUCTURE_LEG_ROLE.BASKET_WING_CALL);
  const needPut = !hasWingRole(structure, STRUCTURE_LEG_ROLE.BASKET_WING_PUT);
  if (!needCall && !needPut) {
    return structure as Omit<T, "legs"> & { legs: WingAwareLeg[] };
  }

  const knownProducts = productIdsInStructure(structure);
  const shortOpenTimes = shorts.map((l) => l.openedAt.getTime());
  const tMin = Math.min(...shortOpenTimes) - WING_ENTRY_MAX_SKEW_MS;
  const tMax = Math.max(...shortOpenTimes) + WING_ENTRY_MAX_SKEW_MS;

  const shortExpiryKeys = new Set(
    shorts
      .map((l) => expiryKeyFromSymbol(l.symbol))
      .filter((k): k is string => k != null),
  );

  // productId → earliest debit cashflow in the entry window
  const candidates = new Map<
    number,
    { occurredAt: Date; symbol: string | null; amount: Prisma.Decimal }
  >();

  for (const row of ledger) {
    if (row.productId == null) continue;
    if (knownProducts.has(row.productId)) continue;
    if (row.transactionType.toLowerCase() !== "cashflow") continue;
    if (!row.amount.isNeg()) continue;
    const t = row.occurredAt.getTime();
    if (t < tMin || t > tMax) continue;

    const kind = optionKindFromSymbol(row.productSymbol);
    if (kind == null) continue;
    if (kind === "call" && !needCall) continue;
    if (kind === "put" && !needPut) continue;

    const exp = expiryKeyFromSymbol(row.productSymbol);
    if (shortExpiryKeys.size > 0 && exp != null && !shortExpiryKeys.has(exp)) {
      continue;
    }

    const prev = candidates.get(row.productId);
    if (!prev || row.occurredAt.getTime() < prev.occurredAt.getTime()) {
      candidates.set(row.productId, {
        occurredAt: row.occurredAt,
        symbol: row.productSymbol,
        amount: row.amount,
      });
    }
  }

  if (candidates.size === 0) return structure;

  const basketSeq = pickBasketSeq(structure);
  const added: WingAwareLeg[] = [];

  const byKind = (kind: "call" | "put"): number | null => {
    let best: { productId: number; at: number } | null = null;
    for (const [productId, info] of candidates) {
      if (optionKindFromSymbol(info.symbol) !== kind) continue;
      const at = info.occurredAt.getTime();
      if (!best || at < best.at) best = { productId, at };
    }
    return best?.productId ?? null;
  };

  const maybeAdd = (kind: "call" | "put", role: string): void => {
    const productId = byKind(kind);
    if (productId == null) return;
    const info = candidates.get(productId)!;
    const closedAt = inferWingClosedAt(
      structure,
      productId,
      info.occurredAt,
      ledger,
    );
    added.push({
      botLegId: syntheticWingBotLegId(productId),
      legRole: role,
      basketSeq,
      adjSeq: 0,
      productId,
      symbol: info.symbol,
      strike: null,
      side: "BUY",
      quantity: shorts[0]?.quantity ?? 1,
      openedAt: info.occurredAt,
      attributionFrom: null,
      closedAt,
    });
    knownProducts.add(productId);
    candidates.delete(productId);
  };

  if (needCall) maybeAdd("call", STRUCTURE_LEG_ROLE.BASKET_WING_CALL);
  if (needPut) maybeAdd("put", STRUCTURE_LEG_ROLE.BASKET_WING_PUT);

  if (added.length === 0) {
    return structure as Omit<T, "legs"> & { legs: WingAwareLeg[] };
  }
  return { ...structure, legs: [...structure.legs, ...added] };
}

function inferWingClosedAt(
  structure: WingAwareStructure,
  productId: number,
  openedAt: Date,
  ledger: WingLedgerHint[],
): Date | null {
  if (structure.status.toLowerCase() !== "closed") return null;
  const graceEnd =
    (structure.closedAt?.getTime() ?? openedAt.getTime()) + 60_000;
  let latest = structure.closedAt?.getTime() ?? openedAt.getTime();
  for (const row of ledger) {
    if (row.productId !== productId) continue;
    const t = row.occurredAt.getTime();
    if (t < openedAt.getTime() || t > graceEnd) continue;
    if (t > latest) latest = t;
  }
  return new Date(latest);
}

/** Heal open wings, then discover missing wing legs from ledger. */
export function normalizeStructureForWings<T extends WingAwareStructure>(
  structure: T,
  ledger: WingLedgerHint[],
): Omit<T, "legs"> & { legs: WingAwareLeg[] } {
  const healed = healOpenWingLegsOnClosedStructure(structure);
  return discoverWingLegsFromLedger(healed, ledger);
}

/**
 * Net credit at entry: short premiums received minus wing premiums paid.
 * Uses each leg's earliest cashflow (SELL → credit, BUY wing → debit).
 */
export function computeBasketNetCredit(args: {
  legs: Array<{ legRole: string; side: string }>;
  firstCashflowByLegKey: Map<string, Prisma.Decimal>;
  legKey: (index: number) => string;
}): Prisma.Decimal {
  let net = new Prisma.Decimal(0);
  args.legs.forEach((leg, index) => {
    const first = args.firstCashflowByLegKey.get(args.legKey(index));
    if (first == null) return;
    const isWing = isWingLegRole(leg.legRole) || isBasketBuySide(leg.side);
    const isShort = isBasketShortRole(leg.legRole) || isBasketSellSide(leg.side);
    if (!isWing && !isShort) return;
    // Shorts contribute positive entry cashflow; wings contribute negative.
    // Summing first cashflows for basket legs yields net credit.
    if (isWing || isShort) {
      net = net.add(first);
    }
  });
  return net;
}

/**
 * Expected commission rows for a fully trade-exited basket:
 * 2-leg → 4 (entry+exit × 2); 4-leg with wings → 8.
 */
export function expectedBasketCommissionRows(legCountBasketOnly: number): number {
  return Math.max(0, legCountBasketOnly) * 2;
}

export function countBasketLegs(legs: Array<{ legRole: string }>): {
  shorts: number;
  wings: number;
  totalBasket: number;
} {
  let shorts = 0;
  let wings = 0;
  for (const leg of legs) {
    if (isWingLegRole(leg.legRole)) wings += 1;
    else if (isBasketShortRole(leg.legRole)) shorts += 1;
  }
  return { shorts, wings, totalBasket: shorts + wings };
}
