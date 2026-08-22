import express from 'express';
import type { PrismaClient } from '@prisma/client';
import { recordTradePnl } from '../controllers/subscriptionController.js';
import {
  isInternalWebhookPnlWritesEnabled,
  TRADE_SOURCE_BOT_SYNC_LEGACY,
} from '../services/tradeBillingFilters.js';

export function createInternalRouter(prisma: PrismaClient) {
  const router = express.Router();

  /**
   * POST /api/internal/bot-trade-closed
   * Called by Delta Bot when a master trade closes.
   * Finds earner users from slave list, records P&L, closes Trade records.
   */
  router.post('/bot-trade-closed', async (req, res) => {
    try {
      const body = req.body as {
        master_trade_id?: number;
        exit_reason?: string;
        final_pnl?: number;
        slaves?: Array<{
          earner_user_id?: string;
          earner_subscription_id?: string;
          actual_quantity?: number;
          call_fill_price?: number;
          put_fill_price?: number;
          slave_account_id?: number;
          slave_name?: string;
        }>;
      };

      const masterTradeId = body.master_trade_id;
      const exitReason = body.exit_reason ?? 'BOT_EXIT';
      const finalPnl = typeof body.final_pnl === 'number' ? body.final_pnl : 0;
      const slaves = Array.isArray(body.slaves) ? body.slaves : [];

      if (!masterTradeId) {
        res.status(400).json({ error: 'master_trade_id required' });
        return;
      }

      console.log(
        `[InternalWebhook] bot-trade-closed master=${masterTradeId} ` +
        `reason=${exitReason} pnl=${finalPnl} slaves=${slaves.length}`,
      );

      const results: Array<{
        earner_user_id: string;
        status: string;
        error?: string;
      }> = [];

      for (const slave of slaves) {
        const userId = slave.earner_user_id;
        if (!userId) continue;

        try {
          // Find user's active subscription to any bot strategy
          const subscription = await prisma.userStrategySubscription.findFirst({
            where: {
              userId,
              isActive: true,
              strategy: {
                botStrategyType: { not: null },
              },
            },
            include: {
              strategy: {
                select: {
                  id: true,
                  profitShare: true,
                  botStrategyType: true,
                },
              },
            },
          });

          if (!subscription) {
            console.warn(
              `[InternalWebhook] No active bot subscription for userId=${userId}`,
            );
            results.push({ earner_user_id: userId, status: 'no_subscription' });
            continue;
          }

          // Calculate user P&L proportional to their multiplier
          const userPnl = finalPnl * (subscription.multiplier ?? 1.0);

          // Find existing OPEN Trade record for this user+strategy
          // or create one if it doesn't exist
          let trade = await prisma.trade.findFirst({
            where: {
              userId,
              strategyId: subscription.strategyId,
              status: 'OPEN',
            },
            orderBy: { createdAt: 'desc' },
          });

          if (trade) {
            // Close the existing trade
            await prisma.trade.update({
              where: { id: trade.id },
              data: {
                status: 'CLOSED',
                exitReason,
                pnl: userPnl,
                tradePnl: userPnl,
                exitPrice: slave.call_fill_price ?? 0,
                source: TRADE_SOURCE_BOT_SYNC_LEGACY,
                updatedAt: new Date(),
              },
            });
          } else {
            // Create and immediately close a trade record
            trade = await prisma.trade.create({
              data: {
                userId,
                strategyId: subscription.strategyId,
                symbol: 'BTC-OPTIONS',
                side: 'SELL',
                size: slave.actual_quantity ?? 1,
                entryPrice: (slave.call_fill_price ?? 0) + (slave.put_fill_price ?? 0),
                exitPrice: 0,
                pnl: userPnl,
                tradePnl: userPnl,
                status: 'CLOSED',
                exitReason,
                source: TRADE_SOURCE_BOT_SYNC_LEGACY,
              },
            });
          }

          // Record PnL for revenue share calculation (retired — gated off by default)
          if (userPnl !== 0) {
            if (isInternalWebhookPnlWritesEnabled()) {
              await recordTradePnl(prisma, {
                userId,
                strategyId: subscription.strategyId,
                tradeProfit: userPnl,
              });
            } else {
              console.log(
                `[InternalWebhook] P&L write skipped ` +
                  `(INTERNAL_WEBHOOK_PNL_WRITES_ENABLED=false) ` +
                  `userId=${userId} pnl=${userPnl.toFixed(4)}`,
              );
            }
          }

          // Update subscription sync status
          await prisma.userStrategySubscription.update({
            where: { id: subscription.id },
            data: {
              syncStatus: 'SYNCED',
              syncError: null,
            },
          });

          console.log(
            `[InternalWebhook] Processed userId=${userId} ` +
            `pnl=${userPnl.toFixed(4)} tradeId=${trade.id}`,
          );

          results.push({ earner_user_id: userId, status: 'ok' });
        } catch (userErr) {
          const errMsg = userErr instanceof Error ? userErr.message : String(userErr);
          console.error(
            `[InternalWebhook] Error for userId=${userId}: ${errMsg}`,
          );
          results.push({ earner_user_id: userId, status: 'error', error: errMsg });
        }
      }

      res.json({
        ok: true,
        master_trade_id: masterTradeId,
        processed: results.length,
        results,
      });
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      console.error('[InternalWebhook] Fatal error:', errMsg);
      res.status(500).json({ error: errMsg });
    }
  });

  return router;
}
