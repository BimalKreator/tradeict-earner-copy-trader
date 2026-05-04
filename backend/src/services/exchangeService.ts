import ccxt from "ccxt";
import {
  decryptDeltaSecretOrPlain,
} from "../utils/encryption.js";

export type TradeSide = "BUY" | "SELL";

export interface ExecuteTradeResult {
  success: boolean;
  orderId?: string;
  raw?: unknown;
  error?: string;
}

/** Normalized open perpetual position from Delta (for dashboards). */
export interface DeltaLivePosition {
  /** CCXT unified symbol (e.g. ETH/USDT:USDT) */
  symbol: string;
  /** Compact ticker-style id aligned with copy-trade symbols (e.g. ETHUSDT). */
  symbolKey: string;
  side: TradeSide;
  contracts: number;
  entryPrice: number | null;
  markPrice: number | null;
  unrealizedPnl: number | null;
  stopLoss: number | null;
  takeProfit: number | null;
  entryTime: string | null;
}

/**
 * Converts compact Delta-style keys (e.g. `ETHUSDT`, `ETHUSD`) or partial unified
 * symbols (`ETH/USDT`) into CCXT perpetual swap form `BASE/QUOTE:SETTLE` as used by
 * Delta + ccxt with `defaultType: "swap"` (typically linear USDT: `BASE/USDT:USDT`).
 */
export function normalizeDeltaPerpSymbolForCcxt(raw: string): string {
  const s = raw.trim();
  if (!s) return s;

  if (s.includes("/")) {
    const colonIdx = s.indexOf(":");
    if (colonIdx !== -1) return s;

    const slash = s.indexOf("/");
    const base = s.slice(0, slash);
    const quote = s.slice(slash + 1);
    const q = quote.toUpperCase();

    if (q === "USDT") return `${base.toUpperCase()}/USDT:USDT`;
    // Align with cosmicSymbolMap: USD-quoted Cosmic instruments → USDT linear swaps on Delta
    if (q === "USD") return `${base.toUpperCase()}/USDT:USDT`;

    return s;
  }

  const upper = s.toUpperCase();
  const usdt = upper.match(/^([A-Z0-9]{2,})(USDT)$/);
  if (usdt) return `${usdt[1]}/USDT:USDT`;
  const usd = upper.match(/^([A-Z0-9]{2,})(USD)$/);
  if (usd) return `${usd[1]}/USDT:USDT`;

  return s;
}

/** Map CCXT unified swap symbol (e.g. ETH/USDT:USDT) to compact ETHUSDT-style key. */
function unifiedSymbolToKey(unifiedSymbol: string): string {
  const slash = unifiedSymbol.indexOf("/");
  if (slash === -1) return unifiedSymbol.replace(/[/:]/g, "").toUpperCase();
  const base = unifiedSymbol.slice(0, slash);
  const after = unifiedSymbol.slice(slash + 1);
  const colon = after.indexOf(":");
  const quote = colon === -1 ? after : after.slice(0, colon);
  return `${base}${quote}`.toUpperCase();
}

function ccxtSideToTradeSide(raw: string | undefined): TradeSide {
  const u = (raw ?? "").toLowerCase();
  if (u === "long" || u === "buy") return "BUY";
  return "SELL";
}

/**
 * Decrypts stored Delta Exchange credentials and submits a market order.
 */
export async function executeTrade(
  encryptedApiKey: string,
  encryptedApiSecret: string,
  symbol: string,
  side: TradeSide,
  size: number,
): Promise<ExecuteTradeResult> {
  try {
    const apiKey = decryptDeltaSecretOrPlain(encryptedApiKey);
    const secret = decryptDeltaSecretOrPlain(encryptedApiSecret);

    const exchange = new ccxt.delta({
      apiKey,
      secret,
      enableRateLimit: true,
      options: {
        defaultType: "swap",
      },
    });

    await exchange.loadMarkets();

    const ccxtSymbol = normalizeDeltaPerpSymbolForCcxt(symbol);
    const ccxtSide = side === "BUY" ? "buy" : "sell";

    let order: Awaited<ReturnType<typeof exchange.createMarketOrder>>;
    try {
      order = await exchange.createMarketOrder(ccxtSymbol, ccxtSide, size);
    } catch (orderErr) {
      const message =
        orderErr instanceof Error ? orderErr.message : String(orderErr);
      console.log(message);
      return {
        success: false,
        error: message,
      };
    }

    return {
      success: true,
      orderId: order.id ?? undefined,
      raw: order,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      success: false,
      error: message,
    };
  }
}

/**
 * Public market data for slippage checks (no API keys required).
 */
export async function fetchDeltaTicker(symbol: string): Promise<{ last?: number }> {
  const exchange = new ccxt.delta({
    enableRateLimit: true,
    options: {
      defaultType: "swap",
    },
  });
  await exchange.loadMarkets();
  const ccxtSymbol = normalizeDeltaPerpSymbolForCcxt(symbol);
  const ticker = await exchange.fetchTicker(ccxtSymbol);
  const raw =
    ticker.last ?? ticker.close ?? ticker.bid ?? ticker.ask ?? undefined;
  if (raw === undefined || typeof raw !== "number") {
    return {};
  }
  return { last: raw };
}

/**
 * Authenticated: fetch non-flat perpetual positions from Delta India (swap).
 */
export async function fetchDeltaOpenPositions(
  apiKeyStored: string,
  apiSecretStored: string,
): Promise<DeltaLivePosition[]> {
  const apiKey = decryptDeltaSecretOrPlain(apiKeyStored);
  const secret = decryptDeltaSecretOrPlain(apiSecretStored);

  const exchange = new ccxt.delta({
    apiKey,
    secret,
    enableRateLimit: true,
    options: {
      defaultType: "swap",
    },
  });

  await exchange.loadMarkets();
  const positions = await exchange.fetchPositions();

  const out: DeltaLivePosition[] = [];
  for (const p of positions) {
    const contracts = Number(p.contracts ?? 0);
    if (!Number.isFinite(contracts) || Math.abs(contracts) < 1e-12) continue;

    const unified = typeof p.symbol === "string" ? p.symbol : "";
    if (!unified) continue;

    const symbolKey = unifiedSymbolToKey(unified);
    const side = ccxtSideToTradeSide(p.side);

    const entryPrice =
      p.entryPrice !== undefined && p.entryPrice !== null
        ? Number(p.entryPrice)
        : null;
    const markPrice =
      p.markPrice !== undefined && p.markPrice !== null
        ? Number(p.markPrice)
        : null;
    const unrealizedPnl =
      p.unrealizedPnl !== undefined && p.unrealizedPnl !== null
        ? Number(p.unrealizedPnl)
        : null;

    let stopLoss: number | null = null;
    let takeProfit: number | null = null;
    const info = p.info as Record<string, unknown> | undefined;
    if (info && typeof info === "object") {
      const sl =
        typeof info.stop_loss_order_price === "number"
          ? info.stop_loss_order_price
          : typeof info.stop_loss_price === "number"
            ? info.stop_loss_price
            : typeof info.stopLossPrice === "number"
              ? info.stopLossPrice
              : null;
      const tp =
        typeof info.take_profit_order_price === "number"
          ? info.take_profit_order_price
          : typeof info.take_profit_price === "number"
            ? info.take_profit_price
            : typeof info.takeProfitPrice === "number"
              ? info.takeProfitPrice
              : null;
      if (sl !== null && Number.isFinite(sl)) stopLoss = sl;
      if (tp !== null && Number.isFinite(tp)) takeProfit = tp;
    }

    let entryTime: string | null = null;
    if (typeof p.datetime === "string" && p.datetime) {
      entryTime = p.datetime;
    } else if (p.timestamp != null && Number.isFinite(p.timestamp)) {
      entryTime = new Date(p.timestamp).toISOString();
    }

    out.push({
      symbol: unified,
      symbolKey,
      side,
      contracts,
      entryPrice: Number.isFinite(entryPrice ?? NaN) ? entryPrice : null,
      markPrice: Number.isFinite(markPrice ?? NaN) ? markPrice : null,
      unrealizedPnl: Number.isFinite(unrealizedPnl ?? NaN) ? unrealizedPnl : null,
      stopLoss,
      takeProfit,
      entryTime,
    });
  }

  return out;
}
