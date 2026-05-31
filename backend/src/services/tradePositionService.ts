import { createHash, randomBytes } from "node:crypto";
import {
  type PrismaClient,
  TradePositionStatus,
} from "@prisma/client";
import type { TradeSide } from "./exchangeService.js";

function compactSymbolKey(s: string): string {
  return s.replace(/[/:]/g, "").toUpperCase();
}

function deltaPairBase(compactNoSlash: string): string | null {
  const u = compactNoSlash.toUpperCase();
  if (u.endsWith("USDT")) return u.slice(0, -4);
  if (u.endsWith("USD") && !u.endsWith("USDT")) return u.slice(0, -3);
  return null;
}

export function tradePositionSymbolsAlign(
  tradeSymbol: string,
  storedSymbol: string,
): boolean {
  const a = compactSymbolKey(tradeSymbol);
  const b = compactSymbolKey(storedSymbol);
  if (a === b || a.endsWith(b) || b.endsWith(a)) return true;
  const ba = deltaPairBase(a);
  const bb = deltaPairBase(b);
  return ba != null && bb != null && ba === bb;
}

/** Delta Exchange client order id max length. */
export const MAX_DELTA_CLIENT_ORDER_ID_LENGTH = 32;

function hashClientOrderId(raw: string): string {
  return createHash("md5").update(raw).digest("hex");
}

/** Stable id for DB row — MD5 hash keeps Delta client order id ≤ 32 chars. */
export function buildClientOrderId(args: {
  strategyId: string;
  userId?: string | null;
  isMaster?: boolean;
  exchangeOrderId?: string | null;
  symbol?: string;
}): string {
  const scope = args.isMaster ? "M" : (args.userId ?? "U");
  if (args.exchangeOrderId?.trim()) {
    return hashClientOrderId(
      `${args.strategyId}|${scope}|${args.exchangeOrderId.trim()}`,
    );
  }
  const sym = compactSymbolKey(args.symbol ?? "sym").slice(0, 24);
  const nonce = randomBytes(4).toString("hex");
  return hashClientOrderId(
    `${args.strategyId}|${scope}|${sym}|${Date.now()}|${nonce}`,
  );
}

/**
 * Deterministic client order id for one follower leg per master fill/close event.
 * Reused across exchange retries so duplicate market orders are rejected/idempotent.
 */
export function buildStableCopyClientOrderId(args: {
  strategyId: string;
  userId: string;
  masterFillKey: string;
  symbol: string;
  side: TradeSide | string;
  leg: "open" | "close";
}): string {
  const sym = compactSymbolKey(args.symbol).slice(0, 24);
  const side = String(args.side).toUpperCase();
  const raw = [
    args.strategyId,
    args.userId,
    args.leg,
    args.masterFillKey.trim(),
    sym,
    side,
  ].join("|");
  return hashClientOrderId(raw);
}

export type RecordTradePositionOpenArgs = {
  strategyId: string;
  userId?: string | null;
  isMaster?: boolean;
  symbol: string;
  side: TradeSide | string;
  quantity: number;
  entryPrice: number;
  exchangeOrderId?: string | null;
  clientOrderId?: string;
};

/**
 * Persist an OPEN leg immediately after a successful market order.
 * Idempotent on `clientOrderId` (duplicate WS/retries skip create).
 */
export async function recordTradePositionOpen(
  prisma: PrismaClient,
  args: RecordTradePositionOpenArgs,
): Promise<{ id: string; clientOrderId: string } | null> {
  const isMaster = args.isMaster === true;
  if (!isMaster && !args.userId) {
    console.warn("[tradePosition] skip open — follower requires userId");
    return null;
  }

  const clientOrderId =
    args.clientOrderId ??
    buildClientOrderId({
      strategyId: args.strategyId,
      isMaster,
      symbol: args.symbol,
      ...(args.userId != null ? { userId: args.userId } : {}),
      ...(args.exchangeOrderId != null
        ? { exchangeOrderId: args.exchangeOrderId }
        : {}),
    });

  const existing = await prisma.tradePosition.findUnique({
    where: { clientOrderId },
    select: { id: true, clientOrderId: true, status: true },
  });
  if (existing) {
    if (existing.status === TradePositionStatus.OPEN) {
      return { id: existing.id, clientOrderId: existing.clientOrderId };
    }
    console.warn(
      `[tradePosition] clientOrderId already CLOSED — skip reopen id=${existing.id}`,
    );
    return null;
  }

  const qty = Math.abs(args.quantity);
  if (!Number.isFinite(qty) || qty <= 0) return null;
  const entry = args.entryPrice;
  if (!Number.isFinite(entry) || entry <= 0) return null;

  const row = await prisma.tradePosition.create({
    data: {
      userId: isMaster ? null : args.userId!,
      isMaster,
      strategyId: args.strategyId,
      symbol: args.symbol,
      side: String(args.side).toUpperCase(),
      quantity: qty,
      entryPrice: entry,
      clientOrderId,
      status: TradePositionStatus.OPEN,
    },
    select: { id: true, clientOrderId: true },
  });

  console.log(
    `[tradePosition] OPEN ${isMaster ? "master" : `user=${args.userId}`} strategyId=${args.strategyId} ${args.symbol} ${args.side} qty=${qty} clientOrderId=${clientOrderId}`,
  );

  return row;
}

export type CloseTradePositionLegArgs = {
  strategyId: string;
  userId?: string | null;
  isMaster?: boolean;
  symbol: string;
  /** Original open side (BUY/SELL), not the reduce-only close side. */
  side: TradeSide | string;
  clientOrderId?: string;
};

/** Mark matching OPEN rows CLOSED for this strategy leg. */
export async function closeTradePositionsForLeg(
  prisma: PrismaClient,
  args: CloseTradePositionLegArgs,
): Promise<number> {
  const isMaster = args.isMaster === true;
  const openSide = String(args.side).toUpperCase();

  if (args.clientOrderId?.trim()) {
    const row = await prisma.tradePosition.findUnique({
      where: { clientOrderId: args.clientOrderId.trim() },
    });
    if (
      row &&
      row.status === TradePositionStatus.OPEN &&
      row.strategyId === args.strategyId &&
      row.isMaster === isMaster &&
      (isMaster || row.userId === args.userId)
    ) {
      await prisma.tradePosition.update({
        where: { id: row.id },
        data: { status: TradePositionStatus.CLOSED },
      });
      console.log(
        `[tradePosition] CLOSED by clientOrderId=${row.clientOrderId} strategyId=${args.strategyId}`,
      );
      return 1;
    }
  }

  const candidates = await prisma.tradePosition.findMany({
    where: {
      strategyId: args.strategyId,
      status: TradePositionStatus.OPEN,
      isMaster,
      ...(isMaster
        ? { userId: null }
        : args.userId != null
          ? { userId: args.userId }
          : {}),
      side: openSide,
    },
    orderBy: { createdAt: "asc" },
  });

  const matches = candidates.filter((r) =>
    tradePositionSymbolsAlign(args.symbol, r.symbol),
  );
  if (matches.length === 0) return 0;

  await prisma.tradePosition.updateMany({
    where: { id: { in: matches.map((m) => m.id) } },
    data: { status: TradePositionStatus.CLOSED },
  });

  console.log(
    `[tradePosition] CLOSED ${matches.length} leg(s) ${isMaster ? "master" : `user=${args.userId}`} strategyId=${args.strategyId} ${args.symbol} ${openSide}`,
  );

  return matches.length;
}

export type GroupedBotManagedLeg = {
  symbol: string;
  side: string;
  quantity: number;
};

/** Sum bot-managed OPEN quantity for one follower leg (ignores manual exchange positions). */
export async function sumOpenFollowerBotQuantity(
  prisma: PrismaClient,
  args: {
    strategyId: string;
    userId: string;
    symbol: string;
    side: TradeSide | string;
  },
): Promise<number> {
  const openSide = String(args.side).toUpperCase();
  const rows = await prisma.tradePosition.findMany({
    where: {
      strategyId: args.strategyId,
      userId: args.userId,
      isMaster: false,
      status: TradePositionStatus.OPEN,
      side: openSide,
    },
    select: { symbol: true, quantity: true },
  });
  return rows
    .filter((r) => tradePositionSymbolsAlign(args.symbol, r.symbol))
    .reduce((sum, r) => sum + Math.abs(r.quantity), 0);
}

/** All OPEN bot-managed legs for a follower on a strategy (grouped by symbol + side). */
export async function listOpenFollowerBotLegs(
  prisma: PrismaClient,
  strategyId: string,
  userId: string,
): Promise<GroupedBotManagedLeg[]> {
  const rows = await prisma.tradePosition.findMany({
    where: {
      strategyId,
      userId,
      isMaster: false,
      status: TradePositionStatus.OPEN,
    },
    orderBy: { createdAt: "asc" },
    select: { symbol: true, side: true, quantity: true },
  });

  const grouped = new Map<string, GroupedBotManagedLeg>();
  for (const row of rows) {
    const side = String(row.side).toUpperCase();
    const key = `${compactSymbolKey(row.symbol)}:${side}`;
    const qty = Math.abs(row.quantity);
    const hit = grouped.get(key);
    if (hit) {
      hit.quantity += qty;
    } else {
      grouped.set(key, { symbol: row.symbol, side, quantity: qty });
    }
  }
  return Array.from(grouped.values());
}

/** Reduce bot-managed OPEN quantity in DB after a reduce-only exchange trim (FIFO rows). */
export async function trimOpenFollowerBotQuantity(
  prisma: PrismaClient,
  args: {
    strategyId: string;
    userId: string;
    symbol: string;
    side: TradeSide | string;
    reduceBy: number;
  },
): Promise<number> {
  let remaining = Math.max(0, Math.floor(args.reduceBy));
  if (remaining <= 0) return 0;

  const openSide = String(args.side).toUpperCase();
  const rows = await prisma.tradePosition.findMany({
    where: {
      strategyId: args.strategyId,
      userId: args.userId,
      isMaster: false,
      status: TradePositionStatus.OPEN,
      side: openSide,
    },
    orderBy: { createdAt: "asc" },
  });
  const matches = rows.filter((r) =>
    tradePositionSymbolsAlign(args.symbol, r.symbol),
  );

  let trimmed = 0;
  for (const row of matches) {
    if (remaining <= 0) break;
    const qty = Math.abs(row.quantity);
    if (qty <= remaining) {
      await prisma.tradePosition.update({
        where: { id: row.id },
        data: { status: TradePositionStatus.CLOSED },
      });
      remaining -= qty;
      trimmed += qty;
    } else {
      await prisma.tradePosition.update({
        where: { id: row.id },
        data: { quantity: qty - remaining },
      });
      trimmed += remaining;
      remaining = 0;
    }
  }
  return trimmed;
}

/** Admin granular sync — add lots to an existing OPEN leg or create a new row. */
export async function incrementOrRecordFollowerTradePosition(
  prisma: PrismaClient,
  args: {
    strategyId: string;
    userId: string;
    symbol: string;
    side: TradeSide | string;
    addLots: number;
    entryPrice: number;
    clientOrderId?: string;
    exchangeOrderId?: string | null;
  },
): Promise<{ id: string } | null> {
  const add = Math.max(1, Math.floor(Math.abs(args.addLots)));
  const openSide = String(args.side).toUpperCase();

  const rows = await prisma.tradePosition.findMany({
    where: {
      strategyId: args.strategyId,
      userId: args.userId,
      isMaster: false,
      status: TradePositionStatus.OPEN,
      side: openSide,
    },
    orderBy: { createdAt: "desc" },
  });
  const existing = rows.find((r) =>
    tradePositionSymbolsAlign(args.symbol, r.symbol),
  );

  if (existing) {
    await prisma.tradePosition.update({
      where: { id: existing.id },
      data: { quantity: Math.abs(existing.quantity) + add },
    });
    console.log(
      `[tradePosition] INCREMENT user=${args.userId} ${args.symbol} ${openSide} +${add} → qty=${Math.abs(existing.quantity) + add}`,
    );
    return { id: existing.id };
  }

  const created = await recordTradePositionOpen(prisma, {
    strategyId: args.strategyId,
    userId: args.userId,
    symbol: args.symbol,
    side: openSide,
    quantity: add,
    entryPrice: args.entryPrice,
    ...(args.clientOrderId ? { clientOrderId: args.clientOrderId } : {}),
    ...(args.exchangeOrderId != null
      ? { exchangeOrderId: args.exchangeOrderId }
      : {}),
  });
  return created ? { id: created.id } : null;
}
