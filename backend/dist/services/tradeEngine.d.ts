import { type PrismaClient } from "@prisma/client";
import { type TradeSide } from "./exchangeService.js";
/** Latest normalized row from Cosmic Open Positions DOM */
export interface CosmicLedTrade {
    id: string;
    symbol: string;
    side: TradeSide;
    size: number;
    entryPrice: number;
}
/**
 * Logs into Cosmic.trade via stealth Puppeteer, scrapes Open Positions every 2–3s,
 * and mirrors new trades to Delta for subscribers. Returns a disposer that closes the browser.
 */
export declare function startTradeEngine(prisma: PrismaClient): () => void;
//# sourceMappingURL=tradeEngine.d.ts.map