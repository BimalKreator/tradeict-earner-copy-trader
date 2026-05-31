import { randomBytes } from "node:crypto";
import type { TradeSide } from "./exchangeService.js";
import { tradePositionSymbolsAlign } from "./tradePositionService.js";

/** Prefix for master orders that must not fan out to followers. */
export const MASTER_NO_COPY_CLIENT_ORDER_PREFIX = "NC_";

/** Delta client order id max length. */
const MAX_CLIENT_ORDER_ID_LEN = 32;

/** Recently placed NC_ order ids (WS may echo before REST suppress is registered). */
const pendingNoCopyOrderIds = new Set<string>();

type RestSuppressEntry = {
  strategyId: string;
  symbol: string;
  side: TradeSide;
  expiresAt: number;
};

const restCopySuppress: RestSuppressEntry[] = [];

const DEFAULT_REST_SUPPRESS_MS = 120_000;

/** Generate `NC_` + hex (≤ 32 chars) for no-copy master adjustments. */
export function buildMasterNoCopyClientOrderId(): string {
  const suffix = randomBytes(10).toString("hex");
  return `${MASTER_NO_COPY_CLIENT_ORDER_PREFIX}${suffix}`.slice(
    0,
    MAX_CLIENT_ORDER_ID_LEN,
  );
}

export function isMasterNoCopyClientOrderId(
  clientOrderId: string | null | undefined,
): boolean {
  const id = String(clientOrderId ?? "").trim();
  return id.startsWith(MASTER_NO_COPY_CLIENT_ORDER_PREFIX);
}

export function registerPendingMasterNoCopyOrderId(
  clientOrderId: string,
  ttlMs = DEFAULT_REST_SUPPRESS_MS,
): void {
  const id = clientOrderId.trim();
  if (!id) return;
  pendingNoCopyOrderIds.add(id);
  setTimeout(() => pendingNoCopyOrderIds.delete(id), ttlMs);
}

export function isPendingMasterNoCopyOrderId(
  clientOrderId: string | null | undefined,
): boolean {
  const id = String(clientOrderId ?? "").trim();
  return id.length > 0 && pendingNoCopyOrderIds.has(id);
}

export function shouldSkipMasterFillCopy(args: {
  clientOrderId?: string | null;
}): boolean {
  const id = String(args.clientOrderId ?? "").trim();
  if (!id) return false;
  return (
    isMasterNoCopyClientOrderId(id) || isPendingMasterNoCopyOrderId(id)
  );
}

/** Suppress REST catch-up copy for a leg after a no-copy master adjustment. */
export function registerMasterNoCopyRestSuppress(args: {
  strategyId: string;
  symbol: string;
  side: TradeSide;
  ttlMs?: number;
}): void {
  const ttl = args.ttlMs ?? DEFAULT_REST_SUPPRESS_MS;
  restCopySuppress.push({
    strategyId: args.strategyId,
    symbol: args.symbol,
    side: args.side,
    expiresAt: Date.now() + ttl,
  });
}

function pruneExpiredRestSuppress(now: number): void {
  for (let i = restCopySuppress.length - 1; i >= 0; i -= 1) {
    if (restCopySuppress[i]!.expiresAt <= now) {
      restCopySuppress.splice(i, 1);
    }
  }
}

/** True when REST/positions WS must not fan out copy for this master leg. */
export function shouldSuppressMasterRestCopy(args: {
  strategyId: string;
  symbol: string;
  openSide: TradeSide;
}): boolean {
  const now = Date.now();
  pruneExpiredRestSuppress(now);
  return restCopySuppress.some(
    (e) =>
      e.strategyId === args.strategyId &&
      e.side === args.openSide &&
      tradePositionSymbolsAlign(args.symbol, e.symbol) &&
      e.expiresAt > now,
  );
}
