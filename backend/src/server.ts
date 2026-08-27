import "./utils/forceIpv4.js";
import "dotenv/config";
import { installTradeLogFilter } from "./utils/tradeLogger.js";
import { bindSystemAlertPrisma } from "./utils/systemAlert.js";

installTradeLogFilter();

import { installProcessHandlers } from "./utils/processHandlers.js";
installProcessHandlers();

if (!process.env.PROCESS_ENCRYPTION_KEY) {
  console.error("FATAL: PROCESS_ENCRYPTION_KEY is missing");
  process.exit(1);
}

import { assertBotWebhookSecretConfigured } from "./middleware/internalAuthMiddleware.js";
assertBotWebhookSecretConfigured();

import cors from "cors";
import cookieParser from "cookie-parser";
import express, { type Request } from "express";
import path from "path";
import { fileURLToPath } from "url";
import pg from "pg";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";
import { createAdminRoutes } from "./routes/adminRoutes.js";
import { createAuthRoutes } from "./routes/authRoutes.js";
import { createSubscriptionRoutes } from "./routes/subscriptionRoutes.js";
import { createAnalyticsRoutes } from "./routes/analyticsRoutes.js";
import { createLeaderboardRoutes } from "./routes/leaderboardRoutes.js";
import { createWalletRoutes } from "./routes/walletRoutes.js";
import { createUserRoutes } from "./routes/userRoutes.js";
import { createMeRoutes } from "./routes/meRoutes.js";
import { createExchangeAccountRoutes } from "./routes/exchangeAccountRoutes.js";
import { createLiveTradesRoutes } from "./routes/liveTradesRoutes.js";
import { createBillingRoutes } from "./routes/billingRoutes.js";
import { createPaymentRoutes } from "./routes/paymentRoutes.js";
import { createNotificationRoutes } from "./routes/notificationRoutes.js";
import {
  createAdminTicketRoutes,
  createTicketRoutes,
} from "./routes/ticketRoutes.js";
import { createPublicRoutes } from "./routes/publicRoutes.js";
import { createArbitrageRoutes } from "./routes/arbitrageRoutes.js";
import { createInternalRouter } from "./routes/internalRoutes.js";
import { requireInternalSignature } from "./middleware/internalAuthMiddleware.js";
import { DELTA_INDIA_CCXT_SAMPLE_SYMBOL } from "./services/exchangeService.js";
import {
  getMasterOrderPolicySnapshot,
  startMasterOrderPolicyRefresh,
} from "./services/masterOrderPolicy.js";
import { initArbitrageEngine } from "./services/arbitrageEngine.js";
import { initBillingCronJobs } from "./services/billingService.js";
import { initDelayedInvoiceCronJobs } from "./services/billingCronService.js";
import { initAffiliateCommissionCronJobs } from "./services/affiliateCommissionService.js";
import { startTradeEngine } from "./services/tradeEngine.js";
import {
  initTelegramBot,
  initTelegramCronJobs,
} from "./services/telegramService.js";
import { startFutureHedgeDataEngine } from "./services/futureHedgeDataService.js";
import { startFutureHedgeEngine } from "./services/futureHedgeEngine.js";
import { startBotSyncService } from "./services/botSyncService.js";
import { countLegacyBotSyncTrades } from "./services/deltaPipelineBillingService.js";
import { initDeltaLedgerCronJobs } from "./services/deltaLedgerService.js";
import { initStructureRevenueCronJobs } from "./services/structureRevenueService.js";
import {
  hardDeleteStrategyByExactTitle,
  removeLegacyCryptoOptionsStrategies,
  consolidateDuplicateFutureHedgeStrategies,
} from "./services/strategyCleanupService.js";

const CRYPTO_OPTIONS_GHOST_TITLE =
  "Crypto Options Trading - For Delta Ex India";

const PORT = parseInt(process.env.PORT ?? '4000', 10);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function getAllowedOrigins(): string[] {
  const list = (process.env.ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);

  if (list.length > 0) return list;

  if (process.env.NODE_ENV === "production") {
    throw new Error("ALLOWED_ORIGINS must be set in production");
  }

  console.warn(
    "[BOOT] ALLOWED_ORIGINS is not set — defaulting to http://localhost:3000",
  );
  return ["http://localhost:3000"];
}

const allowedOrigins = getAllowedOrigins();

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error("DATABASE_URL is not set");
}

const pool = new pg.Pool({ connectionString });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });
bindSystemAlertPrisma(prisma);

void (async () => {
  try {
    const ghost = await hardDeleteStrategyByExactTitle(
      prisma,
      CRYPTO_OPTIONS_GHOST_TITLE,
    );
    if (ghost) {
      console.log(
        `[BOOT] Hard-deleted ghost strategy "${ghost.title}" (${ghost.strategyId})`,
      );
    }
    const legacy = await removeLegacyCryptoOptionsStrategies(prisma);
    if (legacy.removed.length > 0) {
      console.log(
        `[BOOT] Removed ${legacy.removed.length} legacy Crypto Options strateg(ies)`,
      );
    }
    console.log(
      `[BOOT] Primary strategy: "${legacy.primaryStrategyTitle}" (${legacy.primaryStrategyId})`,
    );
    const dup = await consolidateDuplicateFutureHedgeStrategies(prisma);
    if (dup.removed > 0) {
      console.log(
        `[BOOT] Merged ${dup.removed} duplicate Future Hedge row(s) → canonical=${dup.canonicalId} ` +
          `(subscriptions moved=${dup.mergedSubscriptions})`,
      );
    }
  } catch (err) {
    console.error("[BOOT] Strategy cleanup failed:", err);
  }
})();

void (async () => {
  try {
    const n = await prisma.user.count({ where: { isOtpBypassed: true } });
    if (n > 0) {
      console.warn(`[BOOT] WARNING: ${n} account(s) have isOtpBypassed=true`);
    }
  } catch (err) {
    console.error("[BOOT] isOtpBypassed count failed:", err);
  }
})();

initBillingCronJobs(prisma);
initDelayedInvoiceCronJobs(prisma);
initAffiliateCommissionCronJobs(prisma);
initDeltaLedgerCronJobs(prisma);
initStructureRevenueCronJobs(prisma);
initArbitrageEngine(prisma);
initTelegramBot(prisma);
initTelegramCronJobs(prisma);

/** Private WS per strategy (master Delta keys) → copies fills to subscribers. Must run or only late-join / force-sync work. */
const stopTradeEngine = startTradeEngine(prisma);
const stopFutureHedgeDataEngine = startFutureHedgeDataEngine(prisma);
const stopFutureHedgeEngine = startFutureHedgeEngine(prisma);
const stopMasterOrderPolicy = startMasterOrderPolicyRefresh(prisma);

function shutdownBackgroundEngines(): void {
  try {
    stopMasterOrderPolicy();
  } catch {
    /* ignore */
  }
  try {
    stopFutureHedgeEngine();
  } catch {
    /* ignore */
  }
  try {
    stopFutureHedgeDataEngine();
  } catch {
    /* ignore */
  }
  try {
    stopTradeEngine();
  } catch {
    /* ignore */
  }
}
process.once("SIGTERM", shutdownBackgroundEngines);
process.once("SIGINT", shutdownBackgroundEngines);

const app = express();

app.use(
  cors({
    origin: (origin, callback) => {
      if (!origin || allowedOrigins.includes(origin)) {
        callback(null, true);
        return;
      }
      callback(new Error("CORS: origin not allowed"));
    },
    credentials: true,
    allowedHeaders: ["Content-Type", "Authorization"],
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  }),
);
app.use(cookieParser());

app.use(
  "/api/internal",
  express.json({
    verify: (req, _res, buf) => {
      (req as Request).rawBody = buf;
    },
  }),
  requireInternalSignature,
  createInternalRouter(prisma),
);

app.use(express.json());
app.use(
  "/api/downloads",
  express.static(path.join(__dirname, "../public/downloads")),
);
app.use("/uploads", express.static(path.join(__dirname, "../public/uploads")));

/** No auth: proves which `dist/` build is live. Stale PM2 shows wrong `deltaEthUsdtToCcxt` (must be `ETH/USD:USD`). */
app.get("/api/health/build", (_req, res) => {
  const policy = getMasterOrderPolicySnapshot();
  res.json({
    deltaEthUsdtToCcxt: DELTA_INDIA_CCXT_SAMPLE_SYMBOL,
    masterOpensAllowed: policy.opensAllowed,
    masterOpenBlockReason: policy.blockReason,
    masterPolicyRefreshedAt: policy.refreshedAt,
  });
});
app.get("/health/build", (_req, res) => {
  const policy = getMasterOrderPolicySnapshot();
  res.json({
    deltaEthUsdtToCcxt: DELTA_INDIA_CCXT_SAMPLE_SYMBOL,
    masterOpensAllowed: policy.opensAllowed,
    masterOpenBlockReason: policy.blockReason,
    masterPolicyRefreshedAt: policy.refreshedAt,
  });
});

app.use("/api/admin", createAdminRoutes(prisma));
app.use("/api/auth", createAuthRoutes(prisma));
const publicRoutes = createPublicRoutes(prisma);
app.use("/api/public", publicRoutes);
app.use("/public", publicRoutes);
app.use("/api/user", createUserRoutes(prisma));
app.use("/api/me", createMeRoutes(prisma));
app.use("/api/notifications", createNotificationRoutes(prisma));
app.use("/api/tickets", createTicketRoutes(prisma));
app.use("/api/admin/tickets", createAdminTicketRoutes(prisma));
app.use("/api/exchange-accounts", createExchangeAccountRoutes(prisma));

const liveTradesRoutes = createLiveTradesRoutes(prisma);
app.use("/api/live-trades", liveTradesRoutes);
/** Alias when `NEXT_PUBLIC_API_URL` is the origin without `/api` (same pattern as `/subscriptions`). */
app.use("/live-trades", liveTradesRoutes);

app.use("/api/analytics", createAnalyticsRoutes(prisma));

const arbitrageRoutes = createArbitrageRoutes(prisma);
app.use("/api/arbitrage", arbitrageRoutes);
app.use("/arbitrage", arbitrageRoutes);

app.use("/api/leaderboard", createLeaderboardRoutes(prisma));

const subscriptionRoutes = createSubscriptionRoutes(prisma);
app.use("/api/subscriptions", subscriptionRoutes);
/** Alias when `NEXT_PUBLIC_API_URL` is the origin without `/api` (e.g. `http://host:5000`). */
app.use("/subscriptions", subscriptionRoutes);

app.use("/api/wallet", createWalletRoutes(prisma));

const billingRoutes = createBillingRoutes(prisma);
app.use("/api/billing", billingRoutes);
/** Alias when `NEXT_PUBLIC_API_URL` is the origin without `/api`. */
app.use("/billing", billingRoutes);

const paymentRoutes = createPaymentRoutes(prisma);
app.use("/api/payments", paymentRoutes);
app.use("/payments", paymentRoutes);

app.use(
  (
    err: unknown,
    _req: express.Request,
    res: express.Response,
    _next: express.NextFunction,
  ) => {
    console.error(err);
    if (
      typeof err === "object" &&
      err !== null &&
      "code" in err &&
      (err as { code?: string }).code === "MISSING_USD_INR_RATE"
    ) {
      const message =
        err instanceof Error
          ? err.message
          : "USD/INR rate is missing, invalid, or stale";
      res.status(503).json({
        error: message,
        code: "MISSING_USD_INR_RATE",
      });
      return;
    }
    if (
      typeof err === "object" &&
      err !== null &&
      "code" in err &&
      (err as { code?: string }).code === "P2025"
    ) {
      res.status(404).json({ error: "Record not found" });
      return;
    }
    res.status(500).json({ error: "Internal server error" });
  },
);

app.listen(PORT, "0.0.0.0", () => {
  console.log(
    `[BOOT] Admin API http://0.0.0.0:${PORT} deltaEthUSDT→ccxt=${DELTA_INDIA_CCXT_SAMPLE_SYMBOL} | verify: curl -s http://127.0.0.1:${PORT}/api/health/build`,
  );
  console.log("[BOOT] Trade engine (master Delta WebSocket copy) is running.");
  console.log("[BOOT] Future Hedge market data engine (BTC price / EMA) is running.");
  console.log(
    "[BOOT] Future Hedge autonomous engine is DISABLED (SL/TP/breakeven/admin exits only).",
  );
  if (process.env.ARBITRAGE_ENGINE_ENABLED === "1") {
    console.log("[BOOT] Crypto arbitrage engine cron is scheduled (every ~4 min).");
  } else {
    console.log(
      "[BOOT] Crypto arbitrage engine cron is DISABLED (set ARBITRAGE_ENGINE_ENABLED=1 to enable)",
    );
  }
  startBotSyncService(prisma);
  void countLegacyBotSyncTrades(prisma)
    .then((count) => {
      console.log(
        `[BOOT] BOT_SYNC_LEGACY Trade rows marked for comparison: ${count} (billing excludes these)`,
      );
    })
    .catch((err) => {
      console.error("[BOOT] Legacy bot sync trade count failed:", err);
    });
});
