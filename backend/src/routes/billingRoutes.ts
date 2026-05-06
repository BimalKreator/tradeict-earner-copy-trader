import { Router } from "express";
import type { PrismaClient } from "@prisma/client";
import { authenticateJwt } from "../middleware/authMiddleware.js";
import {
  getCurrentMonthBilling,
  getCurrentMonthBillingForUser,
  payInvoiceFromWallet,
} from "../services/billingService.js";

/**
 * Billing routes for the High-Water Mark (Cumulative Monthly PnL)
 * revenue-share system.
 *
 * Mounted at `/api/billing` (see `server.ts`). All endpoints require
 * an authenticated user; queries are always scoped to `req.userId`.
 */
export function createBillingRoutes(prisma: PrismaClient): Router {
  const router = Router();
  const jwtAuth = authenticateJwt();

  /**
   * GET /api/billing/live-cycle?strategyId=...
   *
   * Returns the live month-to-date billing snapshot for the calling user
   * against a single strategy:
   *   { cumulativePnl, estimatedDue }
   *
   * `cumulativePnl` is the sum of realized USD PnL on all CLOSED trades
   * from the 1st of the current UTC month up to "now". `estimatedDue`
   * applies the strategy's profitShare percentage when cumulativePnl is
   * positive, and is `0` otherwise (no negative revenue share).
   */
  router.get("/live-cycle", jwtAuth, async (req, res, next) => {
    try {
      const userId = req.userId;
      if (!userId) {
        res.status(401).json({ error: "Unauthorized" });
        return;
      }

      const rawStrategyId = req.query.strategyId;
      const strategyId =
        typeof rawStrategyId === "string" ? rawStrategyId.trim() : "";
      if (!strategyId) {
        res.status(400).json({ error: "strategyId query param is required" });
        return;
      }

      const result = await getCurrentMonthBilling(prisma, userId, strategyId);
      res.json(result);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.startsWith("Strategy not found")) {
        res.status(404).json({ error: "Strategy not found" });
        return;
      }
      next(err);
    }
  });

  /**
   * GET /api/billing/live-cycle/all
   *
   * Aggregated live month-to-date snapshot across every ACTIVE subscription
   * the calling user owns. Returns:
   *   { totals: { cumulativePnl, estimatedDue }, byStrategy: [...] }
   *
   * The frontend's headline "Estimated Revenue Share Due" reads
   * `totals.estimatedDue`; the per-strategy breakdown is included so the UI
   * can drill in or render a sub-table.
   */
  router.get("/live-cycle/all", jwtAuth, async (req, res, next) => {
    try {
      const userId = req.userId;
      if (!userId) {
        res.status(401).json({ error: "Unauthorized" });
        return;
      }
      const result = await getCurrentMonthBillingForUser(prisma, userId);
      res.json(result);
    } catch (err) {
      next(err);
    }
  });

  /**
   * POST /api/billing/pay-invoice/:id
   *
   * Manually settle a PENDING (or OVERDUE) invoice from the calling user's
   * wallet balance. Atomic: wallet decrement + WalletTransaction insert +
   * invoice flip to PAID happen in a single transaction. Side effect: if the
   * matching subscription was PAUSED_DUE_TO_FUNDS, it's flipped back to
   * ACTIVE in the same transaction.
   */
  router.post("/pay-invoice/:id", jwtAuth, async (req, res, next) => {
    try {
      const userId = req.userId;
      if (!userId) {
        res.status(401).json({ error: "Unauthorized" });
        return;
      }

      const rawId = req.params.id;
      const invoiceId = Array.isArray(rawId) ? rawId[0] : rawId;
      if (typeof invoiceId !== "string" || !invoiceId.trim()) {
        res.status(400).json({ error: "invoice id is required" });
        return;
      }

      const outcome = await payInvoiceFromWallet(prisma, {
        userId,
        invoiceId: invoiceId.trim(),
      });

      if (!outcome.ok) {
        res.status(outcome.status).json({ error: outcome.message });
        return;
      }

      res.json({
        ok: true,
        invoiceId: outcome.invoiceId,
        amountPaid: outcome.amountDue,
        walletBalance: outcome.walletBalance,
      });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
