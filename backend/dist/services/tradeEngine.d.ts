import { type PrismaClient } from "@prisma/client";
/**
 * Polls each subscribed strategy’s linked Cosmic account via HTTP (see `COSMIC_POSITIONS_HTTP_URL`),
 * maps symbols to Delta per `COSMIC_TO_DELTA_SYMBOL`, and mirrors trades for subscribers on Delta Exchange.
 */
export declare function startTradeEngine(prisma: PrismaClient): () => void;
//# sourceMappingURL=tradeEngine.d.ts.map