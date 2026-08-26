import type { PrismaClient } from '@prisma/client';
import {
  isBotSyncWritesEnabled,
  TRADE_SOURCE_BOT_SYNC_LEGACY,
} from './tradeBillingFilters.js';

const BOT_OVERVIEW_URL = 'http://127.0.0.1:8000/api/slave/overview';
const POLL_INTERVAL_MS = 30_000; // 30 seconds
const BOT_TIMEOUT_MS = 10_000;

let syncTimer: ReturnType<typeof setTimeout> | null = null;

async function fetchBotOverview(): Promise<Record<string, unknown> | null> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), BOT_TIMEOUT_MS);
    const res = await fetch(BOT_OVERVIEW_URL, { signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) {
      console.warn(`[BotSync] overview fetch failed: HTTP ${res.status}`);
      return null;
    }
    return (await res.json()) as Record<string, unknown>;
  } catch (err) {
    console.warn('[BotSync] overview fetch error:', err);
    return null;
  }
}

/**
 * Retired billing write path — gated by BOT_SYNC_WRITES_ENABLED (default false).
 * When disabled, the poller still runs for observability but never mutates Trade
 * billing fields (pnl, tradePnl, revenueShareAmt, status, create/close rows).
 */
async function syncOneSlave(
  prisma: PrismaClient,
  slave: Record<string, unknown>,
  _masterTrade: Record<string, unknown> | null,
): Promise<void> {
  if (!isBotSyncWritesEnabled()) {
    return;
  }

  const userId =
    typeof slave.earner_user_id === 'string' ? slave.earner_user_id.trim() : '';
  if (!userId) {
    console.log('[BotSync] syncOneSlave skip: missing earner_user_id');
    return;
  }

  const subscriptionId =
    typeof slave.earner_subscription_id === 'string'
      ? slave.earner_subscription_id.trim()
      : '';
  const activeSlaveTrade =
    slave.active_slave_trade != null &&
    typeof slave.active_slave_trade === 'object'
      ? (slave.active_slave_trade as Record<string, unknown>)
      : null;

  let subscription =
    subscriptionId.length > 0
      ? await prisma.userStrategySubscription.findFirst({
          where: {
            id: subscriptionId,
            userId,
            strategy: {
              botStrategyType: { not: null },
            },
          },
          include: {
            strategy: { select: { id: true, botStrategyType: true } },
          },
        })
      : null;

  if (!subscription) {
    subscription = await prisma.userStrategySubscription.findFirst({
      where: {
        userId,
        OR: [{ isActive: true }, { status: 'ACTIVE' }],
        strategy: {
          AND: [
            { botStrategyType: { not: null } },
            { NOT: { botStrategyType: '' } },
          ],
        },
      },
      include: {
        strategy: { select: { id: true, botStrategyType: true } },
      },
    });
  }

  if (!subscription) {
    return;
  }

  const strategyId = subscription.strategyId;

  const openTrade = await prisma.trade.findFirst({
    where: { userId, strategyId, status: 'OPEN' },
    orderBy: { createdAt: 'desc' },
  });

  if (activeSlaveTrade) {
    const netMtm =
      typeof activeSlaveTrade.net_mtm === 'number'
        ? activeSlaveTrade.net_mtm
        : 0;
    const callEntry =
      typeof activeSlaveTrade.call_fill_price === 'number'
        ? activeSlaveTrade.call_fill_price
        : 0;
    const putEntry =
      typeof activeSlaveTrade.put_fill_price === 'number'
        ? activeSlaveTrade.put_fill_price
        : 0;
    const qty =
      typeof activeSlaveTrade.actual_quantity === 'number'
        ? activeSlaveTrade.actual_quantity
        : 1;
    const underlying =
      typeof activeSlaveTrade.underlying === 'string'
        ? activeSlaveTrade.underlying
        : 'BTC';
    const symbol = `${underlying}-OPTIONS`;

    if (openTrade) {
      await prisma.trade.update({
        where: { id: openTrade.id },
        data: {
          tradePnl: netMtm,
          pnl: netMtm,
          source: TRADE_SOURCE_BOT_SYNC_LEGACY,
          updatedAt: new Date(),
        },
      });
    } else {
      await prisma.trade.create({
        data: {
          userId,
          strategyId,
          symbol,
          side: 'SELL',
          size: qty,
          entryPrice: callEntry + putEntry,
          exitPrice: null,
          pnl: netMtm,
          tradePnl: netMtm,
          status: 'OPEN',
          source: TRADE_SOURCE_BOT_SYNC_LEGACY,
        },
      });
    }
  } else if (openTrade) {
    await prisma.trade.update({
      where: { id: openTrade.id },
      data: {
        status: 'CLOSED',
        exitReason: 'BOT_SYNC_CLOSE',
        exitPrice: 0,
        source: TRADE_SOURCE_BOT_SYNC_LEGACY,
        closedAt: new Date(),
        updatedAt: new Date(),
      },
    });
  }
}

async function runSyncCycle(prisma: PrismaClient): Promise<void> {
  const writesEnabled = isBotSyncWritesEnabled();
  console.log(
    `[BotSync] Cycle running (writes=${writesEnabled ? 'ON' : 'OFF'})...`,
  );

  const overview = await fetchBotOverview();
  if (!overview) {
    console.warn('[BotSync] Cycle abort: overview fetch returned null');
    return;
  }

  const slaves = Array.isArray(overview.slaves)
    ? (overview.slaves as Record<string, unknown>[])
    : [];

  const masterData =
    overview.master != null && typeof overview.master === 'object'
      ? (overview.master as Record<string, unknown>)
      : null;
  const masterTradeRaw = masterData?.active_trade;
  const masterTrade =
    masterTradeRaw != null && typeof masterTradeRaw === 'object'
      ? (masterTradeRaw as Record<string, unknown>)
      : null;

  const earnerSlaves = slaves.filter((s) => {
    const id = s.earner_user_id;
    return typeof id === 'string' && id.trim().length > 0;
  });

  if (earnerSlaves.length === 0) {
    return;
  }

  if (!writesEnabled) {
    console.log(
      `[BotSync] Poll-only: ${earnerSlaves.length} earner slave(s) on bot (no Trade writes)`,
    );
    return;
  }

  for (const slave of earnerSlaves) {
    try {
      await syncOneSlave(prisma, slave, masterTrade);
    } catch (err) {
      console.warn(
        `[BotSync] Error syncing slave earner_user_id=${slave.earner_user_id}:`,
        err,
      );
    }
  }
}

export function startBotSyncService(prisma: PrismaClient): void {
  const writesEnabled = isBotSyncWritesEnabled();
  console.log(
    `[BotSync] Starting bot overview poller (30s interval, writes=${writesEnabled ? 'ON' : 'OFF'})`,
  );

  async function tick(): Promise<void> {
    try {
      await runSyncCycle(prisma);
    } catch (err) {
      console.warn('[BotSync] Cycle error:', err);
    } finally {
      syncTimer = setTimeout(() => void tick(), POLL_INTERVAL_MS);
    }
  }

  syncTimer = setTimeout(() => void tick(), 10_000);
}

export function stopBotSyncService(): void {
  if (syncTimer) {
    clearTimeout(syncTimer);
    syncTimer = null;
  }
  console.log('[BotSync] Stopped');
}
