import ccxt from "ccxt";
import { decryptDeltaSecret } from "../utils/encryption.js";

export type TradeSide = "BUY" | "SELL";

export interface ExecuteTradeResult {
  success: boolean;
  orderId?: string;
  raw?: unknown;
  error?: string;
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
    const apiKey = decryptDeltaSecret(encryptedApiKey);
    const secret = decryptDeltaSecret(encryptedApiSecret);

    const exchange = new ccxt.delta({
      apiKey,
      secret,
      enableRateLimit: true,
      options: {
        defaultType: "swap",
      },
    });

    await exchange.loadMarkets();

    const ccxtSide = side === "BUY" ? "buy" : "sell";
    const order = await exchange.createMarketOrder(symbol, ccxtSide, size);

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
  const ticker = await exchange.fetchTicker(symbol);
  const raw =
    ticker.last ?? ticker.close ?? ticker.bid ?? ticker.ask ?? undefined;
  if (raw === undefined || typeof raw !== "number") {
    return {};
  }
  return { last: raw };
}
