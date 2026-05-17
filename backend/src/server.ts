import "dotenv/config";

if (!process.env.PROCESS_ENCRYPTION_KEY) {
  console.error("FATAL: PROCESS_ENCRYPTION_KEY is missing");
  process.exit(1);
}

import cors from "cors";
import express from "express";
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
import { createExchangeAccountRoutes } from "./routes/exchangeAccountRoutes.js";
import { createLiveTradesRoutes } from "./routes/liveTradesRoutes.js";
import { createBillingRoutes } from "./routes/billingRoutes.js";
import { createPaymentRoutes } from "./routes/paymentRoutes.js";
import { createNotificationRoutes } from "./routes/notificationRoutes.js";
import { createPublicRoutes } from "./routes/publicRoutes.js";
import { createArbitrageRoutes } from "./routes/arbitrageRoutes.js";
import { DELTA_INDIA_CCXT_SAMPLE_SYMBOL } from "./services/exchangeService.js";
import { initArbitrageEngine } from "./services/arbitrageEngine.js";
import { initBillingCronJobs } from "./services/billingService.js";
import { startTradeEngine } from "./services/tradeEngine.js";
import {
  initTelegramBot,
  initTelegramCronJobs,
} from "./services/telegramService.js";

const PORT = 5000;
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error("DATABASE_URL is not set");
}

const pool = new pg.Pool({ connectionString });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

initBillingCronJobs(prisma);
initArbitrageEngine(prisma);
initTelegramBot(prisma);
initTelegramCronJobs(prisma);

/** Private WS per strategy (master Delta keys) → copies fills to subscribers. Must run or only late-join / force-sync work. */
const stopTradeEngine = startTradeEngine(prisma);
function shutdownTradeEngine(): void {
  try {
    stopTradeEngine();
  } catch {
    /* ignore */
  }
}
process.once("SIGTERM", shutdownTradeEngine);
process.once("SIGINT", shutdownTradeEngine);

const app = express();

app.use(
  cors({
    origin: true,
    credentials: true,
    allowedHeaders: ["Content-Type", "Authorization"],
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  }),
);
app.use(express.json());
app.use(
  "/api/downloads",
  express.static(path.join(__dirname, "../public/downloads")),
);
app.use("/uploads", express.static(path.join(__dirname, "../public/uploads")));

/** No auth: proves which `dist/` build is live. Stale PM2 shows wrong `deltaEthUsdtToCcxt` (must be `ETH/USD:USD`). */
app.get("/api/health/build", (_req, res) => {
  res.json({ deltaEthUsdtToCcxt: DELTA_INDIA_CCXT_SAMPLE_SYMBOL });
});
app.get("/health/build", (_req, res) => {
  res.json({ deltaEthUsdtToCcxt: DELTA_INDIA_CCXT_SAMPLE_SYMBOL });
});

app.use("/api/admin", createAdminRoutes(prisma));
app.use("/api/auth", createAuthRoutes(prisma));

const publicRoutes = createPublicRoutes();
app.use("/api/public", publicRoutes);
app.use("/public", publicRoutes);
app.use("/api/user", createUserRoutes(prisma));
app.use("/api/notifications", createNotificationRoutes(prisma));
app.use("/api/exchange-accounts", createExchangeAccountRoutes(prisma));

const liveTradesRoutes = createLiveTradesRoutes(prisma);
app.use("/api/live-trades", liveTradesRoutes);
/** Alias when `NEXT_PUBLIC_API_URL` is the origin without `/api` (same pattern as `/subscriptions`). */
app.use("/live-trades", liveTradesRoutes);

app.use("/api/analytics", createAnalyticsRoutes(prisma));

const arbitrageRoutes = createArbitrageRoutes();
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
  console.log("[BOOT] Crypto arbitrage engine cron is scheduled (every ~4 min).");
});
