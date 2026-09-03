import { Router, type NextFunction, type Request, type Response } from "express";
import {
  Prisma,
  type PrismaClient,
  AdminRole,
  InvoiceStatus,
  Role,
  TradeStatus,
  UserStatus,
} from "@prisma/client";
import { PrismaClientKnownRequestError } from "@prisma/client/runtime/client";
import { authenticateToken, isAdmin, authorizeRoles } from "../middleware/authMiddleware.js";
import { createAdminAuditMiddleware } from "../middleware/adminAuditMiddleware.js";
import { getAdminMasterPositionSnapshots } from "../services/liveTradesService.js";
import {
  generateMonthlyInvoices,
  getPlatformRevenueStats,
  runOverdueCheck,
} from "../services/billingService.js";
import { runDeltaLedgerSyncForUsers } from "../services/deltaLedgerService.js";
import { recomputeStructurePnlForUsers } from "../services/structurePnlService.js";
import {
  runDailyPnlSnapshots,
  runMonthlyRevenueInvoices,
} from "../services/structureRevenueService.js";
import { createAdminDeltaRevenueController } from "../controllers/adminDeltaRevenueController.js";
import { createCancellationBillingController } from "../controllers/cancellationBillingController.js";
import { createDeltaRevenueSimulatorController } from "../controllers/deltaRevenueSimulatorController.js";
import {
  STRATEGY_SELECT_ADMIN_LIST,
  STRATEGY_SELECT_ADMIN_SAFE,
} from "../prisma/strategySelect.js";
import {
  parseFutureHedgeConfigBody,
  upsertFutureHedgeConfigForStrategy,
} from "../services/futureHedgeService.js";
import {
  applyNoStoreCacheHeaders,
  createAdminController,
} from "../controllers/adminController.js";
import {
  computeUserBookedPnlAndRevenueDue,
  realizedTradePnl,
  resolveStoredOrComputedTradeRevenueShare,
} from "../services/dashboardMetricsService.js";
import { createSettingsController } from "../controllers/settingsController.js";
import { createCouponController } from "../controllers/couponController.js";
import { createAdminNotificationController } from "../controllers/adminNotificationController.js";
import { createAdminEmailController } from "../controllers/adminEmailController.js";
import { createFutureHedgeController } from "../controllers/futureHedgeController.js";
import {
  decryptDeltaSecretOrPlain,
  maskDeltaApiKey,
  maskStoredDeltaCredentials,
  normalizeStoredDeltaSecret,
} from "../utils/encryption.js";
import {
  clearDeltaAuthClientCache,
  testDeltaIndiaConnection,
} from "../services/exchangeService.js";
import {
  clearDummyTrades,
  handleInjectTradeRequest,
  isInjectTradeClientError,
} from "../services/dummyTradeInjectorService.js";
import {
  CONFIRM_CLEAR_DUMMY_TRADES,
  CONFIRM_INJECT_TEST_TRADE,
  requireTypedConfirmation,
} from "../utils/requireTypedConfirmation.js";

/** Typed confirmation when admin explicitly issues monthly invoices (ACCRUED → INVOICED). */
const CONFIRM_ISSUE_INVOICE = "ISSUE INVOICE";
import {
  getDeltaRestPauseStatus,
  setDeltaRestApiManualPause,
} from "../utils/deltaRateLimiter.js";
import { getCronStatusSnapshots } from "../utils/cronGuard.js";
import { auditFromRequest } from "../utils/auditLogger.js";

/** Strategy CRUD uses `masterApiKey` / `masterApiSecret` only (leader Delta India CCXT credentials). */
const roleValues = new Set<string>(Object.values(Role));
const statusValues = new Set<string>(Object.values(UserStatus));

function parsePerformanceMetrics(
  v: unknown,
): Prisma.InputJsonValue | undefined {
  if (v === undefined) return undefined;
  if (v === null) return undefined;
  if (typeof v === "object") return v as Prisma.InputJsonValue;
  return undefined;
}

export function createAdminRoutes(prisma: PrismaClient): Router {
  const router = Router();
  const adminController = createAdminController(prisma);
  const settings = createSettingsController(prisma);
  const coupons = createCouponController(prisma);
  const adminNotifications = createAdminNotificationController(prisma);
  const adminEmail = createAdminEmailController(prisma);
  const futureHedge = createFutureHedgeController(prisma);
  const deltaRevenue = createAdminDeltaRevenueController(prisma);
  const cancellationBilling = createCancellationBillingController(prisma);
  const deltaSimulator = createDeltaRevenueSimulatorController(prisma);

  router.use(
    authenticateToken(prisma),
    isAdmin(prisma),
    authorizeRoles(AdminRole.SUPER_ADMIN, AdminRole.MANAGER),
    createAdminAuditMiddleware(prisma),
  );

  const superAdminOnly = authorizeRoles(AdminRole.SUPER_ADMIN);
  const walletManagers = authorizeRoles(
    AdminRole.SUPER_ADMIN,
    AdminRole.MANAGER,
  );

  router.get("/audit-logs", walletManagers, adminController.listAuditLogs);
  router.get("/me", adminController.getAdminMe);
  router.get("/managers", superAdminOnly, adminController.listManagers);
  router.post("/managers", superAdminOnly, adminController.createManager);

  /** GET /api/admin/system/api-pause — Delta REST pause status (CDN auto + manual kill switch). */
  router.get("/system/api-pause", (_req, res) => {
    res.json(getDeltaRestPauseStatus());
  });

  /** PUT /api/admin/system/api-pause — toggle manual REST kill switch `{ "paused": true|false }`. */
  router.put("/system/api-pause", superAdminOnly, (req, res) => {
    const paused = (req.body as { paused?: unknown })?.paused;
    if (typeof paused !== "boolean") {
      res.status(400).json({ error: "paused must be a boolean" });
      return;
    }
    setDeltaRestApiManualPause(paused);
    res.json(getDeltaRestPauseStatus());
  });

  router.post("/resend-registration-email", adminEmail.resendRegistrationEmail);
  router.post("/send-custom-email", adminEmail.sendCustomEmailToUser);

  router.get("/strategies/future-hedge", futureHedge.getConfig);
  router.get("/strategies/future-hedge/market", futureHedge.getMarket);
  router.put("/strategies/future-hedge", futureHedge.updateConfig);

  router.post("/notifications/broadcast", adminNotifications.broadcast);

  router.get("/coupons", coupons.list);
  router.post("/coupons", superAdminOnly, coupons.create);
  router.post("/coupons/bulk", superAdminOnly, coupons.createBulk);
  router.patch("/coupons/:id/toggle", coupons.toggleActive);

  router.get("/settings/payment", settings.getPaymentSettings);
  router.put("/settings/payment", superAdminOnly, settings.updatePaymentSettings);
  router.get(
    "/settings/partner-commission",
    settings.getPartnerCommissionSettings,
  );
  router.put(
    "/settings/partner-commission",
    superAdminOnly,
    settings.updatePartnerCommissionSettings,
  );

  /** GET /api/admin/system/cron — in-memory cron job health (last run, duration, overlap skips). */
  router.get("/system/cron", (_req, res) => {
    const crons = getCronStatusSnapshots();
    const now = Date.now();
    res.json({
      checkedAt: new Date(now).toISOString(),
      crons,
      summary: {
        total: crons.length,
        running: crons.filter((c) => c.running).length,
        failedLastRun: crons.filter((c) => c.lastSuccess === false).length,
        neverRun: crons.filter((c) => c.lastStartedAt == null).length,
      },
    });
  });

  /** GET /api/admin/system/alerts — open or resolved SystemAlert rows for admin review. */
  router.get("/system/alerts", async (req, res, next) => {
    try {
      const resolvedParam = String(req.query.resolved ?? "false").toLowerCase();
      const resolved = resolvedParam === "true";
      const severityRaw = req.query.severity;
      const severity =
        severityRaw === "CRITICAL" || severityRaw === "WARN"
          ? severityRaw
          : undefined;

      const alerts = await prisma.systemAlert.findMany({
        where: {
          resolved,
          ...(severity ? { severity } : {}),
        },
        orderBy: [{ severity: "asc" }, { lastSeenAt: "desc" }],
        take: 200,
        select: {
          id: true,
          key: true,
          severity: true,
          source: true,
          message: true,
          detail: true,
          count: true,
          firstSeenAt: true,
          lastSeenAt: true,
          acknowledgedAt: true,
          acknowledgedById: true,
          resolved: true,
        },
      });

      res.json({ alerts, total: alerts.length });
    } catch (err) {
      next(err);
    }
  });

  /** POST /api/admin/system/alerts/:id/ack — mark alert as seen (stays open). */
  router.post("/system/alerts/:id/ack", async (req, res, next) => {
    try {
      const id = req.params.id?.trim();
      if (!id) {
        res.status(400).json({ error: "Alert id required" });
        return;
      }
      const adminId = req.admin?.id;
      if (!adminId) {
        res.status(401).json({ error: "Unauthorized" });
        return;
      }

      const updated = await prisma.systemAlert.updateMany({
        where: { id, resolved: false },
        data: {
          acknowledgedAt: new Date(),
          acknowledgedById: adminId,
        },
      });

      if (updated.count === 0) {
        res.status(404).json({ error: "Alert not found or already resolved" });
        return;
      }

      const alert = await prisma.systemAlert.findUnique({ where: { id } });
      res.json({ ok: true, alert });
    } catch (err) {
      next(err);
    }
  });

  /** POST /api/admin/system/alerts/:id/resolve — close alert (allows future re-raise on same key). */
  router.post("/system/alerts/:id/resolve", async (req, res, next) => {
    try {
      const id = req.params.id?.trim();
      if (!id) {
        res.status(400).json({ error: "Alert id required" });
        return;
      }
      const adminId = req.admin?.id;
      if (!adminId) {
        res.status(401).json({ error: "Unauthorized" });
        return;
      }

      const existing = await prisma.systemAlert.findUnique({ where: { id } });
      if (!existing || existing.resolved) {
        res.status(404).json({ error: "Alert not found or already resolved" });
        return;
      }

      const alert = await prisma.systemAlert.update({
        where: { id },
        data: { resolved: true },
      });

      auditFromRequest(
        prisma,
        req,
        "RESOLVE_SYSTEM_ALERT",
        "SystemAlert",
        id,
        {
          key: alert.key,
          severity: alert.severity,
          source: alert.source,
          message: alert.message,
          count: alert.count,
        },
      );

      res.json({ ok: true, alert });
    } catch (err) {
      next(err);
    }
  });

  router.get("/engine-status", (_req, res) => {
    const crons = getCronStatusSnapshots();
    const running = crons.filter((c) => c.running);
    const failed = crons.filter((c) => c.lastSuccess === false);
    const neverRun = crons.filter((c) => c.lastStartedAt == null);

    let status: "healthy" | "degraded" | "starting" = "healthy";
    if (failed.length > 0 || running.length > 0) {
      status = "degraded";
    } else if (neverRun.length === crons.length && crons.length > 0) {
      status = "starting";
    }

    res.json({
      status,
      uptimeSeconds: Math.floor(process.uptime()),
      cronJobs: {
        total: crons.length,
        running: running.length,
        failedLastRun: failed.length,
        neverRun: neverRun.length,
      },
      deltaRestPause: getDeltaRestPauseStatus(),
    });
  });

  async function injectTradeHandler(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      if (!requireTypedConfirmation(req, res, CONFIRM_INJECT_TEST_TRADE)) {
        return;
      }
      const result = await handleInjectTradeRequest(
        prisma,
        (req.body ?? {}) as Record<string, unknown>,
      );
      res.status(201).json({ ok: true, ...result });
    } catch (err) {
      if (err instanceof Error && isInjectTradeClientError(err.message)) {
        res.status(400).json({ error: err.message });
        return;
      }
      next(err);
    }
  }

  /** POST /api/admin/debug/inject-trade — PnL + commission test (no exchange). */
  router.post("/debug/inject-trade", superAdminOnly, injectTradeHandler);
  /** @deprecated use /debug/inject-trade */
  router.post("/debug/inject-dummy-trade", superAdminOnly, injectTradeHandler);

  /** POST /api/admin/delta-ledger/sync — trigger Delta wallet ledger ingestion. */
  router.post("/delta-ledger/sync", async (req, res, next) => {
    try {
      const rawUserId = (req.body as { userId?: unknown })?.userId;
      const userId =
        typeof rawUserId === "string" && rawUserId.trim().length > 0
          ? rawUserId.trim()
          : undefined;

      const results = await runDeltaLedgerSyncForUsers(
        prisma,
        userId ? { userId } : undefined,
      );

      if (userId && Object.keys(results).length === 0) {
        res.status(404).json({
          error: "User not eligible for Delta ledger sync or has no ExchangeAccount credentials",
        });
        return;
      }

      res.json({ ok: true, results });
    } catch (err) {
      next(err);
    }
  });

  /** POST /api/admin/structure-pnl/recompute — structure P&L from Delta ledger. */
  router.post("/structure-pnl/recompute", async (req, res, next) => {
    try {
      const rawUserId = (req.body as { userId?: unknown })?.userId;
      const userId =
        typeof rawUserId === "string" && rawUserId.trim().length > 0
          ? rawUserId.trim()
          : undefined;

      const results = await recomputeStructurePnlForUsers(
        prisma,
        userId ? { userId } : undefined,
      );

      if (userId && Object.keys(results).length === 0) {
        res.status(404).json({
          error: "User not eligible for structure P&L recompute",
        });
        return;
      }

      res.json({ ok: true, results });
    } catch (err) {
      next(err);
    }
  });

  /** POST /api/admin/revenue/snapshot — daily P&L snapshot (IST). */
  router.post("/revenue/snapshot", async (req, res, next) => {
    try {
      const body = (req.body ?? {}) as { userId?: unknown; date?: unknown };
      const userId =
        typeof body.userId === "string" && body.userId.trim().length > 0
          ? body.userId.trim()
          : undefined;
      const date =
        typeof body.date === "string" && body.date.trim().length > 0
          ? body.date.trim()
          : undefined;

      const results = await runDailyPnlSnapshots(
        prisma,
        userId || date ? { ...(userId ? { userId } : {}), ...(date ? { date } : {}) } : undefined,
      );

      if (userId && Object.keys(results).length === 0) {
        res.status(404).json({ error: "User not eligible for daily snapshot" });
        return;
      }

      res.json({ ok: true, results });
    } catch (err) {
      next(err);
    }
  });

  /** POST /api/admin/revenue/invoice — monthly revenue invoice (IST). */
  router.post("/revenue/invoice", async (req, res, next) => {
    try {
      const body = (req.body ?? {}) as {
        userId?: unknown;
        year?: unknown;
        month?: unknown;
        issue?: unknown;
      };
      const userId =
        typeof body.userId === "string" && body.userId.trim().length > 0
          ? body.userId.trim()
          : undefined;
      const year =
        typeof body.year === "number"
          ? body.year
          : typeof body.year === "string"
            ? parseInt(body.year, 10)
            : undefined;
      const month =
        typeof body.month === "number"
          ? body.month
          : typeof body.month === "string"
            ? parseInt(body.month, 10)
            : undefined;

      let issue: boolean | undefined;
      if (typeof body.issue === "boolean") {
        issue = body.issue;
      } else if (body.issue === undefined || body.issue === null) {
        issue = undefined;
      } else {
        res.status(400).json({ error: "issue must be a boolean when provided" });
        return;
      }

      if (issue === true) {
        if (!requireTypedConfirmation(req, res, CONFIRM_ISSUE_INVOICE)) {
          return;
        }
      }

      const runOpts =
        userId || year != null || month != null || issue !== undefined
          ? {
              ...(userId ? { userId } : {}),
              ...(year != null && Number.isFinite(year) ? { year } : {}),
              ...(month != null && Number.isFinite(month) ? { month } : {}),
              ...(issue !== undefined ? { issue } : {}),
            }
          : undefined;

      const { results, issued } = await runMonthlyRevenueInvoices(prisma, runOpts);

      if (userId && Object.keys(results).length === 0) {
        res.status(404).json({ error: "User not eligible for monthly invoice" });
        return;
      }

      res.json({ ok: true, results, issued });
    } catch (err) {
      next(err);
    }
  });

  /** DELETE /api/admin/debug/clear-dummy-trades — purge injected test data. */
  router.delete("/debug/clear-dummy-trades", superAdminOnly, async (req, res, next) => {
    try {
      if (!requireTypedConfirmation(req, res, CONFIRM_CLEAR_DUMMY_TRADES)) {
        return;
      }
      const result = await clearDummyTrades(prisma);
      res.json({ ok: true, ...result });
    } catch (err) {
      next(err);
    }
  });
  router.get("/dashboard-stats", adminController.getDashboardStats);
  router.get("/transactions", adminController.listTransactions);
  router.get("/downloads", adminController.listDownloads);
  router.delete("/downloads/:id", adminController.deleteDownload);
  router.get("/deposits", adminController.listAllDeposits);
  router.put("/deposits/:id", adminController.updateDepositStatus);

  router.get("/users/list", adminController.listUsersMinimal);
  router.get("/users/search", adminController.searchUsers);

  router.get("/members", adminController.listTeamMembers);
  router.post("/members/upgrade", adminController.upgradeTeamMember);
  router.patch("/members/:id/upline", adminController.changeTeamMemberUpline);
  router.get("/upgrade-requests", adminController.listMemberUpgradeRequests);
  router.post(
    "/upgrade-requests/:id/approve",
    adminController.approveMemberUpgradeRequest,
  );
  router.post(
    "/upgrade-requests/:id/reject",
    adminController.rejectMemberUpgradeRequest,
  );
  router.get("/referral-requests", adminController.listReferralRequests);
  router.patch(
    "/referral-requests/:id",
    adminController.patchReferralRequestStatus,
  );
  router.get("/tier-config", adminController.getTierConfig);
  router.put("/tier-config", superAdminOnly, adminController.putTierConfig);
  router.get("/network-tree", adminController.getNetworkTree);

  router.get("/payouts", adminController.listPartnerPayouts);
  router.post("/payouts/:id/approve", adminController.approvePartnerPayout);
  router.post("/payouts/:id/reject", adminController.rejectPartnerPayout);
  router.post("/payouts/:id/complete", adminController.completePartnerPayout);

  router.get("/wallet/withdrawals", adminController.listWalletWithdrawals);
  router.get("/wallet/summary", adminController.getWalletAdminSummary);
  router.get("/wallet/users", adminController.listWalletUsers);
  router.post(
    "/wallet/withdrawals/:id/process",
    walletManagers,
    adminController.processWalletWithdrawal,
  );
  router.post(
    "/wallet/users/:userId/adjust",
    walletManagers,
    adminController.adjustUserWallet,
  );

  router.get("/users", adminController.listUsersForAdmin);

  router.get("/users/:id/onboarding", adminController.getUserOnboardingStatus);
  router.post("/users/:id/subscribe", adminController.adminSubscribeUser);

  router.get("/users/:id/management", async (req, res, next) => {
    try {
      const { id } = req.params;
      const user = await prisma.user.findUnique({
        where: { id },
        select: {
          id: true,
          name: true,
          email: true,
          mobile: true,
          address: true,
          panNumber: true,
          aadharNumber: true,
          status: true,
          copyTradingPaused: true,
          cryptoArbitrageEnabled: true,
          arbAccess: true,
          cryptoBalance: true,
          cryptoCapitalPerTradePercent: true,
          deltaBalanceDisplayOffset: true,
          arbitrageSourceUserId: true,
          acquiredById: true,
          acquiredBy: {
            select: {
              id: true,
              name: true,
              email: true,
              affiliateProfile: { select: { referralCode: true } },
            },
          },
          arbitrageSourceUser: {
            select: { id: true, email: true, name: true },
          },
          deltaApiKeys: {
            orderBy: { id: "desc" },
            take: 1,
            select: { id: true, nickname: true, apiKey: true, apiSecret: true },
          },
          exchangeAccounts: {
            orderBy: { createdAt: "desc" },
            take: 1,
            select: {
              id: true,
              nickname: true,
              exchange: true,
              apiKey: true,
              apiSecret: true,
            },
          },
        },
      });
      if (!user) {
        res.status(404).json({ error: "User not found" });
        return;
      }
      res.json({
        user: {
          id: user.id,
          name: user.name,
          email: user.email,
          mobile: user.mobile,
          address: user.address,
          panNumber: user.panNumber,
          aadharNumber: user.aadharNumber,
          status: user.status,
          copyTradingPaused: user.copyTradingPaused,
          cryptoArbitrageEnabled: user.cryptoArbitrageEnabled,
          arbAccess: user.arbAccess,
          cryptoBalance: user.cryptoBalance,
          cryptoCapitalPerTradePercent: user.cryptoCapitalPerTradePercent,
          balanceDisplayOffset: user.deltaBalanceDisplayOffset,
          arbitrageSourceUserId: user.arbitrageSourceUserId,
          arbitrageSourceUser: user.arbitrageSourceUser,
          acquiredById: user.acquiredById,
          acquiredBy: user.acquiredBy
            ? {
                id: user.acquiredBy.id,
                name: user.acquiredBy.name,
                email: user.acquiredBy.email,
                referralCode:
                  user.acquiredBy.affiliateProfile?.referralCode ?? null,
              }
            : null,
        },
        billingReady: user.exchangeAccounts.length > 0,
        deltaApiKey: user.deltaApiKeys[0]
          ? {
              id: user.deltaApiKeys[0].id,
              nickname: user.deltaApiKeys[0].nickname,
              ...maskStoredDeltaCredentials(user.deltaApiKeys[0]),
            }
          : null,
        exchangeAccount: user.exchangeAccounts[0]
          ? {
              id: user.exchangeAccounts[0].id,
              nickname: user.exchangeAccounts[0].nickname,
              exchange: user.exchangeAccounts[0].exchange,
              ...maskStoredDeltaCredentials(user.exchangeAccounts[0]),
            }
          : null,
      });
    } catch (err) {
      next(err);
    }
  });

  router.post(
    "/users/:id/close-structure-and-finalise-billing",
    superAdminOnly,
    cancellationBilling.adminCloseStructureAndFinalise,
  );

  router.post("/simulate/structure", superAdminOnly, deltaSimulator.postSimulateStructure);
  router.post("/simulate/purge", superAdminOnly, deltaSimulator.postPurge);
  router.get("/simulate/chain/:userId", superAdminOnly, deltaSimulator.getChain);
  router.patch(
    "/users/:id/allow-simulation",
    superAdminOnly,
    deltaSimulator.patchAllowSimulation,
  );

  router.get("/users/:id/crypto-arbitrage", adminController.getUserCryptoArbitrage);
  router.patch(
    "/users/:id/crypto-arbitrage/enabled",
    adminController.patchUserCryptoArbitrageEnabled,
  );
  router.patch(
    "/users/:id/crypto-arbitrage/balance",
    adminController.patchUserCryptoArbitrageBalance,
  );
  router.patch(
    "/users/:id/crypto-arbitrage/allocation",
    adminController.patchUserCryptoArbitrageAllocation,
  );
  router.get(
    "/users/:id/arbitrage-withdrawals",
    adminController.listUserArbitrageWithdrawals,
  );
  router.post(
    "/users/:id/arbitrage-withdrawals",
    adminController.createUserArbitrageWithdrawal,
  );
  router.post("/users/:id/sync-arbitrage", adminController.syncUserArbitrage);

  router.patch("/users/:id/copy-trading", async (req, res, next) => {
    try {
      const { id } = req.params;
      const body = req.body as { paused?: unknown; active?: unknown };
      let paused: boolean | undefined;
      if (typeof body.paused === "boolean") {
        paused = body.paused;
      } else if (typeof body.active === "boolean") {
        paused = !body.active;
      }
      if (paused === undefined) {
        res.status(400).json({ error: "Provide paused (boolean) or active (boolean)" });
        return;
      }
      const user = await prisma.user.update({
        where: { id },
        data: { copyTradingPaused: paused },
        select: { id: true, copyTradingPaused: true },
      });
      res.json(user);
    } catch (err) {
      next(err);
    }
  });

  router.patch(
    "/users/:id/otp-bypass",
    superAdminOnly,
    adminController.patchUserOtpBypass,
  );

  router.patch(
    "/users/:id/arb-access",
    adminController.patchUserArbAccess,
  );

  router.patch("/users/:id/status", async (req, res, next) => {
    try {
      const { id } = req.params;
      const status = String((req.body as { status?: unknown }).status ?? "").toUpperCase();
      if (!statusValues.has(status)) {
        res.status(400).json({ error: "status must be ACTIVE or SUSPENDED" });
        return;
      }
      const user = await prisma.user.update({
        where: { id },
        data: { status: status as UserStatus },
        select: { id: true, status: true, email: true, name: true },
      });
      res.json(user);
    } catch (err) {
      next(err);
    }
  });

  router.put("/users/:id/api-keys", superAdminOnly, async (req, res, next) => {
    try {
      const id = String(req.params.id);
      const body = req.body as {
        apiKey?: unknown;
        apiSecret?: unknown;
        nickname?: unknown;
      };
      if (
        typeof body.apiKey !== "string" ||
        typeof body.apiSecret !== "string" ||
        body.apiKey.trim() === "" ||
        body.apiSecret.trim() === ""
      ) {
        res.status(400).json({ error: "apiKey and apiSecret are required" });
        return;
      }

      const user = await prisma.user.findUnique({
        where: { id },
        select: { id: true, email: true },
      });
      if (!user) {
        res.status(404).json({ error: "User not found" });
        return;
      }

      const nickname =
        typeof body.nickname === "string" && body.nickname.trim()
          ? body.nickname.trim()
          : "Primary";

      let storedApiKey: string;
      let storedApiSecret: string;
      try {
        // Same encryption path as exchangeAccountController.create
        storedApiKey = normalizeStoredDeltaSecret(body.apiKey);
        storedApiSecret = normalizeStoredDeltaSecret(body.apiSecret);
      } catch (credErr) {
        const msg =
          credErr instanceof Error ? credErr.message : String(credErr);
        res.status(400).json({ error: msg });
        return;
      }

      const existing = await prisma.exchangeAccount.findFirst({
        where: { userId: id },
        orderBy: { createdAt: "desc" },
        select: { id: true },
      });

      const exchangeAccount = existing
        ? await prisma.exchangeAccount.update({
            where: { id: existing.id },
            data: {
              nickname,
              exchange: "Delta",
              apiKey: storedApiKey,
              apiSecret: storedApiSecret,
            },
            select: {
              id: true,
              nickname: true,
              exchange: true,
              apiKey: true,
              apiSecret: true,
            },
          })
        : await prisma.exchangeAccount.create({
            data: {
              userId: id,
              nickname,
              exchange: "Delta",
              apiKey: storedApiKey,
              apiSecret: storedApiSecret,
            },
            select: {
              id: true,
              nickname: true,
              exchange: true,
              apiKey: true,
              apiSecret: true,
            },
          });

      clearDeltaAuthClientCache();
      const connectionTest = await testDeltaIndiaConnection(
        exchangeAccount.apiKey,
        exchangeAccount.apiSecret,
      );

      const billingReady = true;

      res.json({
        billingReady,
        connectionTest: {
          success: connectionTest.success,
          error: connectionTest.error ?? null,
          openPositionCount: connectionTest.openPositionCount ?? null,
          availableBalanceUsd: connectionTest.availableBalanceUsd ?? null,
        },
        exchangeAccount: {
          id: exchangeAccount.id,
          nickname: exchangeAccount.nickname,
          exchange: exchangeAccount.exchange,
          ...maskStoredDeltaCredentials(exchangeAccount),
        },
      });
    } catch (err) {
      next(err);
    }
  });

  router.get("/users/:id/strategies", async (req, res, next) => {
    try {
      const { id } = req.params;
      const user = await prisma.user.findUnique({
        where: { id },
        select: { id: true, email: true },
      });
      if (!user) {
        res.status(404).json({ error: "User not found" });
        return;
      }

      const subscriptions = await prisma.userStrategySubscription.findMany({
        where: { userId: id },
        orderBy: { joinedDate: "desc" },
        select: {
          id: true,
          status: true,
          multiplier: true,
          joinedDate: true,
          strategyId: true,
          strategy: { select: { title: true } },
          exchangeAccount: { select: { id: true, nickname: true, exchange: true } },
        },
      });

      res.json({
        user,
        strategies: subscriptions.map((s) => ({
          id: s.id,
          strategyId: s.strategyId,
          strategyTitle: s.strategy.title,
          status: s.status,
          multiplier: s.multiplier,
          joinedDate: s.joinedDate,
          exchangeAccount: s.exchangeAccount,
        })),
      });
    } catch (err) {
      next(err);
    }
  });

  router.get("/users/:id/trades", adminController.getUserTradesBilling);
  router.get("/users/:id/transactions", async (req, res, next) => {
    try {
      const { id } = req.params;
      const rows = await prisma.transaction.findMany({
        where: { userId: id },
        orderBy: { createdAt: "desc" },
        select: {
          id: true,
          amount: true,
          type: true,
          status: true,
          createdAt: true,
        },
      });
      res.json({ transactions: rows });
    } catch (err) {
      next(err);
    }
  });
  router.get("/users/:id/change-requests", async (req, res, next) => {
    try {
      const { id } = req.params;
      const rows = await prisma.profileUpdateRequest.findMany({
        where: { userId: id, status: "PENDING" },
        orderBy: { createdAt: "desc" },
        select: {
          id: true,
          address: true,
          panNumber: true,
          aadharNumber: true,
          status: true,
          createdAt: true,
        },
      });
      const current = await prisma.user.findUnique({
        where: { id },
        select: { address: true, panNumber: true, aadharNumber: true },
      });
      res.json({ current, requests: rows });
    } catch (err) {
      next(err);
    }
  });
  router.post("/users/:id/change-requests/:requestId/approve", async (req, res, next) => {
    try {
      const { id, requestId } = req.params;
      const reqRow = await prisma.profileUpdateRequest.findFirst({
        where: { id: requestId, userId: id, status: "PENDING" },
      });
      if (!reqRow) {
        res.status(404).json({ error: "Pending profile update request not found" });
        return;
      }
      await prisma.$transaction([
        prisma.user.update({
          where: { id },
          data: {
            ...(reqRow.address !== null ? { address: reqRow.address } : {}),
            ...(reqRow.panNumber !== null ? { panNumber: reqRow.panNumber } : {}),
            ...(reqRow.aadharNumber !== null
              ? { aadharNumber: reqRow.aadharNumber }
              : {}),
          },
        }),
        prisma.profileUpdateRequest.update({
          where: { id: reqRow.id },
          data: { status: "APPROVED", reviewedAt: new Date() },
        }),
      ]);
      res.json({ ok: true, message: "Profile update request approved." });
    } catch (err) {
      next(err);
    }
  });
  router.post("/users/:id/change-requests/:requestId/reject", async (req, res, next) => {
    try {
      const { id, requestId } = req.params;
      const updated = await prisma.profileUpdateRequest.updateMany({
        where: { id: requestId, userId: id, status: "PENDING" },
        data: { status: "REJECTED", reviewedAt: new Date() },
      });
      if (updated.count === 0) {
        res.status(404).json({ error: "Pending profile update request not found" });
        return;
      }
      res.json({ ok: true, message: "Profile update request rejected." });
    } catch (err) {
      next(err);
    }
  });
  router.get("/users/:id/balance", adminController.getUserBalance);
  router.patch(
    "/users/:id/balance-display-offset",
    adminController.patchUserDeltaBalanceDisplayOffset,
  );
  router.post("/users/:id/reset-password-link", adminController.sendResetPasswordLink);
  router.post("/users/flush-trades", superAdminOnly, adminController.flushUserTrades);
  router.post("/trades/flush-all", superAdminOnly, adminController.flushAllPlatformTrades);
  router.post(
    "/users/:id/trades/reconcile-stale-open",
    adminController.reconcileUserStaleOpenTrades,
  );
  router.post(
    "/users/flush-arbitrage-trades",
    superAdminOnly,
    adminController.flushArbitrageTrades,
  );
  router.delete(
    "/users/:id/trades/flush",
    superAdminOnly,
    adminController.flushUserTrades,
  );
  router.get("/trades", adminController.listAllTrades);
  router.post("/trades/export", adminController.exportTrades);
  router.patch(
    "/strategies/:id/auto-exit",
    adminController.patchStrategyAutoExit,
  );
  router.post("/trades/close-manual", adminController.closeManualTrade);

  router.get("/users/:id/trades-billing", async (req, res, next) => {
    try {
      const { id } = req.params;
      const user = await prisma.user.findUnique({
        where: { id },
        select: { id: true, email: true, name: true },
      });
      if (!user) {
        res.status(404).json({ error: "User not found" });
        return;
      }

      const trades = await prisma.trade.findMany({
        where: { userId: id },
        orderBy: { createdAt: "desc" },
        take: 200,
        select: {
          id: true,
          createdAt: true,
          strategyId: true,
          symbol: true,
          side: true,
          size: true,
          entryPrice: true,
          exitPrice: true,
          tradePnl: true,
          pnl: true,
          revenueShareAmt: true,
          status: true,
          strategy: { select: { title: true, profitShare: true } },
        },
      });

      const normalizedTrades = trades.map((t) => {
        const realized = realizedTradePnl(t);
        const adminRevenue = resolveStoredOrComputedTradeRevenueShare({
          realizedPnl: realized,
          profitSharePct: t.strategy.profitShare,
          revenueShareAmt: t.revenueShareAmt,
        });
        return {
          id: t.id,
          createdAt: t.createdAt,
          strategyId: t.strategyId,
          strategyTitle: t.strategy.title,
          symbol: t.symbol,
          side: t.side,
          size: t.size,
          entryPrice: t.entryPrice,
          exitPrice: t.exitPrice,
          status: t.status,
          pnl: realized,
          adminRevenue,
        };
      });

      const allTimeBooked = await computeUserBookedPnlAndRevenueDue(
        prisma,
        id,
        null,
      );
      const [paidAgg, dueAgg] = await Promise.all([
        prisma.invoice.aggregate({
          where: { userId: id, status: InvoiceStatus.PAID },
          _sum: { amountDue: true },
        }),
        prisma.invoice.aggregate({
          where: { userId: id, status: { in: [InvoiceStatus.PENDING, InvoiceStatus.OVERDUE] } },
          _sum: { amountDue: true },
        }),
      ]);

      res.json({
        user,
        trades: normalizedTrades,
        billingSummary: {
          totalPnlToDate: allTimeBooked.grossPnl,
          totalAdminCommissionEarned: allTimeBooked.appRevenue,
          amountPaid: paidAgg._sum.amountDue ?? 0,
          balanceDue: dueAgg._sum.amountDue ?? 0,
        },
      });
    } catch (err) {
      next(err);
    }
  });

  router.post("/users", adminController.createPlatformUser);

  router.put("/users/:id", adminController.updateUserProfile);
  router.get("/users/:id/profile", adminController.getUserProfileDetails);
  router.put("/users/:id/profile", adminController.updateUserProfileDetails);
  router.post(
    "/users/:id/change-referrer",
    adminController.changeUserReferrer,
  );

  router.delete("/users/:id", superAdminOnly, adminController.deleteUserSafely);

  router.get("/strategies", async (_req, res, next) => {
    try {
      const strategies = await prisma.strategy.findMany({
        orderBy: { createdAt: "desc" },
        select: STRATEGY_SELECT_ADMIN_LIST,
      });
      res.json(
        strategies.map((s) => {
          const { masterApiKey, masterApiSecret, ...rest } = s;
          const hasSecret = Boolean(masterApiSecret?.trim());
          const hasKey = Boolean(decryptDeltaSecretOrPlain(masterApiKey ?? "").trim());
          const credPresent = hasKey && hasSecret;
          return {
            ...rest,
            masterApiKeyMasked: maskDeltaApiKey(masterApiKey ?? ""),
            hasMasterApiKey: hasKey,
            hasMasterApiSecret: hasSecret,
            masterConnection: {
              credentialsPresent: credPresent,
              ready: credPresent,
            },
          };
        }),
      );
    } catch (err) {
      next(err);
    }
  });

  router.post("/strategies", async (req, res, next) => {
    try {
      const body = req.body as Record<string, unknown>;
      const title = body.title;
      const description = body.description;
      const masterApiKey = body.masterApiKey;
      const slippage = body.slippage;
      const monthlyFee = body.monthlyFee;
      const profitShare = body.profitShare;
      const minCapital = body.minCapital;

      const botStrategyType =
        typeof body.botStrategyType === "string" && body.botStrategyType.trim()
          ? body.botStrategyType.trim()
          : null;
      const botUrl =
        typeof body.botUrl === "string" && body.botUrl.trim()
          ? body.botUrl.trim()
          : null;
      const isBotPowered = botStrategyType != null;

      if (
        typeof title !== "string" ||
        typeof description !== "string" ||
        (!isBotPowered && typeof masterApiKey !== "string") ||
        typeof monthlyFee !== "number" ||
        typeof minCapital !== "number"
      ) {
        res.status(400).json({
          error: isBotPowered
            ? "title, description, monthlyFee, and minCapital are required (numbers where applicable)"
            : "title, description, masterApiKey, monthlyFee, and minCapital are required (numbers where applicable)",
        });
        return;
      }

      if (typeof slippage !== "number" || typeof profitShare !== "number") {
        res.status(400).json({
          error: "slippage and profitShare must be numbers",
        });
        return;
      }

      const masterApiSecret =
        typeof body.masterApiSecret === "string" ? body.masterApiSecret : "";
      const performanceMetrics = parsePerformanceMetrics(
        body.performanceMetrics,
      );

      const syncActiveTrades =
        typeof body.syncActiveTrades === "boolean"
          ? body.syncActiveTrades
          : false;

      let storedMasterApiKey: string;
      let storedMasterApiSecret: string;
      try {
        const keyInput =
          typeof masterApiKey === "string" ? masterApiKey : "";
        storedMasterApiKey = normalizeStoredDeltaSecret(keyInput);
        storedMasterApiSecret = masterApiSecret
          ? normalizeStoredDeltaSecret(masterApiSecret)
          : "";
      } catch (credErr) {
        const msg =
          credErr instanceof Error ? credErr.message : String(credErr);
        res.status(400).json({ error: msg });
        return;
      }

      const strategy = await prisma.strategy.create({
        data: {
          title,
          description,
          masterApiKey: storedMasterApiKey,
          masterApiSecret: storedMasterApiSecret,
          botStrategyType,
          botUrl,
          ...(performanceMetrics !== undefined
            ? { performanceMetrics }
            : {}),
          slippage,
          monthlyFee,
          profitShare,
          minCapital,
          baseCapital:
            typeof body.baseCapital === "number" && body.baseCapital > 0
              ? body.baseCapital
              : minCapital,
          syncActiveTrades,
        },
        select: STRATEGY_SELECT_ADMIN_SAFE,
      });

      res.status(201).json(strategy);
    } catch (err) {
      next(err);
    }
  });

  router.get(
    "/strategies/:id/subscribers",
    adminController.listStrategySubscribers,
  );
  router.put(
    "/strategies/:strategyId/subscribers/:userId",
    adminController.updateStrategySubscriber,
  );
  router.post(
    "/strategies/:strategyId/sync-user/:userId",
    adminController.syncStrategyUser,
  );

  router.post("/strategies/test-master-connection", async (req, res) => {
    try {
      const body = req.body as Record<string, unknown>;
      const strategyId =
        typeof body.strategyId === "string" ? body.strategyId.trim() : "";
      let masterApiKey =
        typeof body.masterApiKey === "string" ? body.masterApiKey.trim() : "";
      let masterApiSecret =
        typeof body.masterApiSecret === "string"
          ? body.masterApiSecret.trim()
          : "";

      if (strategyId) {
        const strat = await prisma.strategy.findUnique({
          where: { id: strategyId },
          select: { masterApiKey: true, masterApiSecret: true },
        });
        if (!strat) {
          res.status(404).json({ success: false, error: "Strategy not found" });
          return;
        }
        if (!masterApiKey && strat.masterApiKey?.trim()) {
          masterApiKey = strat.masterApiKey;
        }
        if (!masterApiSecret && strat.masterApiSecret?.trim()) {
          masterApiSecret = strat.masterApiSecret;
        }
      }

      if (!masterApiKey || !masterApiSecret) {
        res.status(400).json({
          success: false,
          error:
            "Master API key and secret are required (enter both or save the strategy first).",
        });
        return;
      }

      const result = await testDeltaIndiaConnection(
        masterApiKey,
        masterApiSecret,
      );
      res.json(result);
    } catch (err) {
      const message =
        err instanceof Error ? err.message : String(err ?? "Unknown error");
      res.status(500).json({ success: false, error: message });
    }
  });

  router.put("/strategies/:id", async (req, res, next) => {
    try {
      const { id } = req.params;
      const body = req.body as Record<string, unknown>;

      const data: {
        title?: string;
        description?: string;
        masterApiKey?: string;
        masterApiSecret?: string;
        performanceMetrics?: Prisma.InputJsonValue | typeof Prisma.DbNull;
        slippage?: number;
        monthlyFee?: number;
        profitShare?: number;
        minCapital?: number;
        baseCapital?: number;
        isActive?: boolean;
        syncActiveTrades?: boolean;
      } = {};

      let futureHedgeInput: ReturnType<typeof parseFutureHedgeConfigBody> = null;
      if (body.futureHedgeConfig !== undefined) {
        futureHedgeInput = parseFutureHedgeConfigBody(body.futureHedgeConfig);
        if (futureHedgeInput == null) {
          res.status(400).json({
            error: "futureHedgeConfig must be an object",
          });
          return;
        }
        if (Object.keys(futureHedgeInput).length === 0) {
          res.status(400).json({
            error:
              "futureHedgeConfig must include at least one of: isAutoEnabled, baseLots, emaPeriod, adjustmentPct, targetProfitUsd, isBreakevenExitEnabled, breakevenPrice1, breakevenPrice2",
          });
          return;
        }
      }

      if (body.title !== undefined) {
        if (typeof body.title !== "string") {
          res.status(400).json({ error: "title must be a string" });
          return;
        }
        data.title = body.title;
      }
      if (body.description !== undefined) {
        if (typeof body.description !== "string") {
          res.status(400).json({ error: "description must be a string" });
          return;
        }
        data.description = body.description;
      }
      if (body.masterApiKey !== undefined) {
        if (typeof body.masterApiKey !== "string") {
          res.status(400).json({ error: "masterApiKey must be a string" });
          return;
        }
        data.masterApiKey = body.masterApiKey;
      }
      if (body.masterApiSecret !== undefined) {
        if (typeof body.masterApiSecret !== "string") {
          res.status(400).json({ error: "masterApiSecret must be a string" });
          return;
        }
        if (body.masterApiSecret !== "") {
          data.masterApiSecret = body.masterApiSecret;
        }
      }
      if (body.performanceMetrics !== undefined) {
        if (body.performanceMetrics === null) {
          data.performanceMetrics = Prisma.DbNull;
        } else {
          const pm = parsePerformanceMetrics(body.performanceMetrics);
          if (pm === undefined) {
            res.status(400).json({
              error: "performanceMetrics must be a JSON object",
            });
            return;
          }
          data.performanceMetrics = pm;
        }
      }
      if (body.slippage !== undefined) {
        if (typeof body.slippage !== "number") {
          res.status(400).json({ error: "slippage must be a number" });
          return;
        }
        data.slippage = body.slippage;
      }
      if (body.monthlyFee !== undefined) {
        if (typeof body.monthlyFee !== "number") {
          res.status(400).json({ error: "monthlyFee must be a number" });
          return;
        }
        data.monthlyFee = body.monthlyFee;
      }
      if (body.profitShare !== undefined) {
        if (typeof body.profitShare !== "number") {
          res.status(400).json({ error: "profitShare must be a number" });
          return;
        }
        data.profitShare = body.profitShare;
      }
      if (body.minCapital !== undefined) {
        if (typeof body.minCapital !== "number") {
          res.status(400).json({ error: "minCapital must be a number" });
          return;
        }
        data.minCapital = body.minCapital;
      }
      if (body.baseCapital !== undefined) {
        if (typeof body.baseCapital !== "number" || body.baseCapital <= 0) {
          res.status(400).json({ error: "baseCapital must be a positive number" });
          return;
        }
        data.baseCapital = body.baseCapital;
      }
      if (body.syncActiveTrades !== undefined) {
        if (typeof body.syncActiveTrades !== "boolean") {
          res.status(400).json({ error: "syncActiveTrades must be a boolean" });
          return;
        }
        data.syncActiveTrades = body.syncActiveTrades;
      }
      if (body.isActive !== undefined) {
        if (typeof body.isActive !== "boolean") {
          res.status(400).json({ error: "isActive must be a boolean" });
          return;
        }
        data.isActive = body.isActive;
      }
      if (
        Object.keys(data).length === 0 &&
        (futureHedgeInput == null || Object.keys(futureHedgeInput).length === 0)
      ) {
        res.status(400).json({ error: "No valid fields to update" });
        return;
      }

      try {
        const existingSync = await prisma.strategy.findUnique({
          where: { id },
          select: { syncActiveTrades: true },
        });

        const updateData: Prisma.StrategyUpdateInput = {};
        if (data.title !== undefined) updateData.title = data.title;
        if (data.description !== undefined)
          updateData.description = data.description;
        try {
          if (data.masterApiKey !== undefined)
            updateData.masterApiKey = normalizeStoredDeltaSecret(
              data.masterApiKey,
            );
          if (data.masterApiSecret !== undefined)
            updateData.masterApiSecret = normalizeStoredDeltaSecret(
              data.masterApiSecret,
            );
        } catch (credErr) {
          const msg =
            credErr instanceof Error ? credErr.message : String(credErr);
          res.status(400).json({ error: msg });
          return;
        }
        if (data.performanceMetrics !== undefined)
          updateData.performanceMetrics = data.performanceMetrics;
        if (data.slippage !== undefined) updateData.slippage = data.slippage;
        if (data.monthlyFee !== undefined)
          updateData.monthlyFee = data.monthlyFee;
        if (data.profitShare !== undefined)
          updateData.profitShare = data.profitShare;
        if (data.minCapital !== undefined)
          updateData.minCapital = data.minCapital;
        if (data.baseCapital !== undefined)
          updateData.baseCapital = data.baseCapital;
        if (data.syncActiveTrades !== undefined)
          updateData.syncActiveTrades = data.syncActiveTrades;
        if (data.isActive !== undefined) updateData.isActive = data.isActive;

        if (futureHedgeInput != null && Object.keys(futureHedgeInput).length > 0) {
          try {
            await upsertFutureHedgeConfigForStrategy(prisma, id, futureHedgeInput);
          } catch (hedgeErr) {
            const msg =
              hedgeErr instanceof Error ? hedgeErr.message : String(hedgeErr);
            res.status(400).json({ error: msg });
            return;
          }
        }

        const strategy =
          Object.keys(updateData).length > 0
            ? await prisma.strategy.update({
                where: { id },
                data: updateData,
                select: STRATEGY_SELECT_ADMIN_SAFE,
              })
            : await prisma.strategy.findUniqueOrThrow({
                where: { id },
                select: STRATEGY_SELECT_ADMIN_SAFE,
              });

        if (
          data.masterApiKey !== undefined ||
          data.masterApiSecret !== undefined
        ) {
          clearDeltaAuthClientCache();
        }

        if (
          existingSync &&
          !existingSync.syncActiveTrades &&
          strategy.syncActiveTrades &&
          strategy.isActive
        ) {
          const strategyId = id;
          void import("../services/tradeEngine.js")
            .then(({ lateJoinMirrorForAllActiveSubscribers }) =>
              lateJoinMirrorForAllActiveSubscribers(prisma, strategyId),
            )
            .catch((err) => {
              const msg = err instanceof Error ? err.message : String(err);
              console.error(
                `[admin] syncActiveTrades backfill failed strategyId=${id}:`,
                msg,
              );
            });
        }

        res.json(strategy);
      } catch (err: unknown) {
        if (
          err instanceof PrismaClientKnownRequestError &&
          err.code === "P2025"
        ) {
          res.status(404).json({ error: "Strategy not found" });
          return;
        }
        return next(err);
      }
    } catch (err) {
      next(err);
    }
  });

  /**
   * Force mirror master Delta open positions to all ACTIVE subscribers (same as late-join `executeTrade` path).
   * Does not require `syncActiveTrades` on the strategy.
   */
  router.post("/strategies/:id/force-sync", superAdminOnly, async (req, res, next) => {
    try {
      const id = String(req.params.id);
      const { forceMirrorOpenPositionsForAllSubscribers } = await import(
        "../services/tradeEngine.js"
      );
      const result = await forceMirrorOpenPositionsForAllSubscribers(
        prisma,
        id,
      );
      res.json({
        ok: true,
        strategyId: id,
        masterOpenLegs: result.masterOpenLegs,
        activeSubscribers: result.activeSubscribers,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (
        msg.includes("must be set") ||
        msg.includes("Failed to fetch master")
      ) {
        res.status(400).json({ error: msg });
        return;
      }
      next(err);
    }
  });

  router.delete("/strategies/:id", superAdminOnly, async (req, res, next) => {
    try {
      const id = String(req.params.id);
      await prisma.strategy.delete({ where: { id } });
      res.status(204).send();
    } catch (err) {
      next(err);
    }
  });

  router.get("/revenue", adminController.getRevenueAnalytics);

  /** Delta-derived revenue (StructurePnl / DailyPnlSnapshot / MonthlyRevenueInvoice). */
  router.get("/revenue/unbilled-users", deltaRevenue.getUnbilledUsers);
  router.get("/revenue/overview", deltaRevenue.getOverview);
  router.get("/revenue/reconcile", deltaRevenue.getReconcile);
  router.post("/revenue/recompute-chain", deltaRevenue.postRecomputeChain);
  router.post("/revenue/invoice/:id/status", deltaRevenue.postInvoiceStatus);
  router.post("/revenue/invoice/:id/credit-note", deltaRevenue.postInvoiceCreditNote);
  router.get("/revenue/invoice/:id/commissions", deltaRevenue.getInvoiceCommissions);
  router.get("/revenue/invoice/:id/ledger", deltaRevenue.getInvoiceLedger);
  router.get(
    "/revenue/structure/:structurePnlId/ledger",
    deltaRevenue.getStructureLedger,
  );
  router.get("/revenue/health", deltaRevenue.getHealth);
  router.get("/revenue/attribution-health", deltaRevenue.getAttributionHealth);
  router.get("/revenue/user/:userId", deltaRevenue.getUserDetail);
  router.patch("/revenue/user/:userId/profit-share", deltaRevenue.patchProfitShareOverride);

  /**
   * Manual fire-the-cron endpoint for QA / staging.
   *
   * Runs `generateMonthlyInvoices` (the 1st-of-month job) and then
   * `runOverdueCheck` (the daily job) so a single call covers the entire
   * billing pipeline. Body accepts optional `{ month, year }` (1-indexed)
   * to target a specific calendar month — defaults to the previous calendar
   * month, mirroring the real cron.
   *
   * NOTE: keep behind admin auth; remove or feature-flag before production.
   */
  router.post("/trigger-billing-cron", superAdminOnly, async (req, res, next) => {
    try {
      const body = (req.body ?? {}) as {
        month?: unknown;
        year?: unknown;
        userIds?: unknown;
        subscriptionIds?: unknown;
      };

      const opts: {
        month?: number;
        year?: number;
        scope?: { userIds?: string[]; subscriptionIds?: string[] };
      } = {};
      if (body.month !== undefined) {
        const m = Number(body.month);
        if (!Number.isInteger(m) || m < 1 || m > 12) {
          res
            .status(400)
            .json({ error: "month must be an integer between 1 and 12" });
          return;
        }
        opts.month = m;
      }
      if (body.year !== undefined) {
        const y = Number(body.year);
        if (!Number.isInteger(y) || y < 1970 || y > 9999) {
          res.status(400).json({ error: "year must be a 4-digit integer" });
          return;
        }
        opts.year = y;
      }

      if (
        (opts.month !== undefined && opts.year === undefined) ||
        (opts.year !== undefined && opts.month === undefined)
      ) {
        res
          .status(400)
          .json({ error: "month and year must be supplied together" });
        return;
      }

      const scope: { userIds?: string[]; subscriptionIds?: string[] } = {};
      if (Array.isArray(body.userIds)) {
        const list = body.userIds.filter(
          (x): x is string => typeof x === "string" && x.length > 0,
        );
        if (list.length > 0) scope.userIds = list;
      }
      if (Array.isArray(body.subscriptionIds)) {
        const list = body.subscriptionIds.filter(
          (x): x is string => typeof x === "string" && x.length > 0,
        );
        if (list.length > 0) scope.subscriptionIds = list;
      }
      if (scope.userIds || scope.subscriptionIds) {
        opts.scope = scope;
      }

      const monthly = await generateMonthlyInvoices(prisma, opts);
      const overdue = await runOverdueCheck(prisma);

      res.json({ ok: true, monthly, overdue });
    } catch (err) {
      next(err);
    }
  });

  /**
   * GET /api/admin/revenue-stats
   *
   * Global platform metrics for the admin revenue dashboard:
   *   - `totalPlatformPnl`  — Σ realized PnL across every CLOSED trade
   *                          this UTC month (all users).
   *   - `expectedRevenue`   — Σ profitShare-weighted positive cumulative PnL
   *                          across every ACTIVE subscription this month.
   *   - `collectedRevenue`  — Σ amountDue from PAID invoices (all-time).
   *   - `pendingDues`       — Σ amountDue from PENDING + OVERDUE invoices.
   */
  router.get("/revenue-stats", async (_req, res, next) => {
    try {
      const [platformStats, paidAgg, pendingAgg] = await Promise.all([
        getPlatformRevenueStats(prisma),
        prisma.invoice.aggregate({
          where: { status: InvoiceStatus.PAID },
          _sum: { amountDue: true },
        }),
        prisma.invoice.aggregate({
          where: {
            status: { in: [InvoiceStatus.PENDING, InvoiceStatus.OVERDUE] },
          },
          _sum: { amountDue: true },
        }),
      ]);

      res.json({
        totalPlatformPnl: platformStats.totalPlatformPnl,
        expectedRevenue: platformStats.expectedRevenue,
        collectedRevenue: paidAgg._sum.amountDue ?? 0,
        pendingDues: pendingAgg._sum.amountDue ?? 0,
      });
    } catch (err) {
      next(err);
    }
  });

  router.get("/revenue/analytics", adminController.getRevenueAnalytics);

  router.get("/revenue/monthly-breakdown", async (_req, res, next) => {
    try {
      const rows = await prisma.invoice.findMany({
        orderBy: [{ year: "desc" }, { month: "desc" }],
        select: { year: true, month: true, amountDue: true, status: true },
      });
      const byMonth = new Map<
        string,
        { year: number; month: number; paid: number; pending: number; overdue: number; total: number }
      >();
      for (const r of rows) {
        const key = `${r.year}-${r.month}`;
        const entry = byMonth.get(key) ?? {
          year: r.year,
          month: r.month,
          paid: 0,
          pending: 0,
          overdue: 0,
          total: 0,
        };
        entry.total += r.amountDue;
        if (r.status === InvoiceStatus.PAID) entry.paid += r.amountDue;
        if (r.status === InvoiceStatus.PENDING) entry.pending += r.amountDue;
        if (r.status === InvoiceStatus.OVERDUE) entry.overdue += r.amountDue;
        byMonth.set(key, entry);
      }
      res.json({ months: Array.from(byMonth.values()) });
    } catch (err) {
      next(err);
    }
  });

  /**
   * GET /api/admin/invoices?status=ALL|PENDING_OVERDUE
   *
   * Master invoice list for the admin revenue dashboard. Each row joins the
   * owning user's email + the strategy title so the table is self-contained.
   * Default order: most recent billing period first.
   *
   * The `status` query param is a convenience server-side filter; the
   * dashboard also filters client-side with the same predicate.
   */
  router.get("/invoices", async (req, res, next) => {
    try {
      const statusRaw = req.query.status;
      const where:
        | { status?: { in: ("PENDING" | "OVERDUE")[] } }
        | Record<string, never> = {};
      if (typeof statusRaw === "string") {
        const upper = statusRaw.trim().toUpperCase();
        if (upper === "PENDING_OVERDUE" || upper === "OUTSTANDING") {
          (where as { status: { in: ("PENDING" | "OVERDUE")[] } }).status = {
            in: [InvoiceStatus.PENDING, InvoiceStatus.OVERDUE],
          };
        }
      }

      const rows = await prisma.invoice.findMany({
        where,
        orderBy: [
          { year: "desc" },
          { month: "desc" },
          { createdAt: "desc" },
        ],
        select: {
          id: true,
          userId: true,
          strategyId: true,
          month: true,
          year: true,
          totalPnl: true,
          amountDue: true,
          dueDate: true,
          status: true,
          createdAt: true,
          updatedAt: true,
          user: { select: { email: true, name: true } },
          strategy: { select: { title: true } },
        },
      });

      const invoices = rows.map((r) => ({
        id: r.id,
        userId: r.userId,
        userEmail: r.user.email,
        userName: r.user.name,
        strategyId: r.strategyId,
        strategyTitle: r.strategy.title,
        month: r.month,
        year: r.year,
        totalPnl: r.totalPnl,
        amountDue: r.amountDue,
        dueDate: r.dueDate.toISOString(),
        status: r.status,
        createdAt: r.createdAt.toISOString(),
        updatedAt: r.updatedAt.toISOString(),
      }));

      res.json({ invoices });
    } catch (err) {
      next(err);
    }
  });

  /** Live trades grouped by strategy — `[{ strategy, masterPositions, subscribers }]`. */
  router.get("/live-trades/grouped", adminController.getGroupedLiveTrades);

  /**
   * Admin granular force sync — add exact lot counts per master leg (no multiplier).
   * Body: `{ userId, strategyId, legs: [{ symbol, side, addLots }] }`
   */
  router.post("/live-trades/granular-sync", adminController.granularSyncLiveTrades);
  router.post(
    "/live-trades/close-all",
    superAdminOnly,
    adminController.closeAllLiveTrades,
  );
  router.post(
    "/live-trades/sync-all-followers",
    superAdminOnly,
    adminController.syncAllFollowersToMaster,
  );

  /**
   * Admin manual follower lot adjustment on one open leg.
   * Body: `{ userId, strategyId, symbol, currentSide, adjustmentLots }`
   */
  router.post(
    "/live-trades/adjust-follower-qty",
    adminController.adjustFollowerQtyLiveTrade,
  );

  /**
   * Bulk admin follower lot adjustment — same delta applied to every open leg.
   * Body: `{ userId, strategyId, adjustmentLots }`
   */
  router.post(
    "/live-trades/bulk-adjust-follower",
    adminController.bulkAdjustFollowerLiveTrades,
  );

  /**
   * Admin master lot adjustment with optional follower fan-out.
   * Body: `{ strategyId, symbol, currentSide, adjustmentLots, copyToUsers }`
   */
  router.post(
    "/live-trades/adjust-master",
    adminController.adjustMasterQtyLiveTrade,
  );

  /**
   * Bulk admin master lot adjustment — same delta on every open master leg.
   * Body: `{ strategyId, adjustmentLots, copyToUsers }`
   */
  router.post(
    "/live-trades/bulk-adjust-master",
    adminController.bulkAdjustMasterLiveTrades,
  );

  /**
   * Master Delta (India) open positions per strategy via CCXT `fetchOpenPositions` (see `exchangeService.fetchDeltaOpenPositions`).
   * For full master + subscriber matching, use `GET /admin/live-trades/grouped`.
   */
  router.get("/live-trades/master-positions", async (_req, res) => {
    try {
      const strategies = await getAdminMasterPositionSnapshots(prisma);
      applyNoStoreCacheHeaders(res);
      res.json({ strategies });
    } catch (err) {
      const message =
        err instanceof Error ? err.message : String(err ?? "Unknown error");
      console.error("[live-trades] GET /master-positions failed:", message);
      res.status(500).json({
        success: false,
        message: "Error fetching live trades",
        error: message,
      });
    }
  });

  return router;
}
