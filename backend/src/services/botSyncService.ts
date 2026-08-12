import type { PrismaClient } from '@prisma/client';

const BOT_OVERVIEW_URL = 'http://127.0.0.1:8000/api/slave/overview';
const POLL_INTERVAL_MS = 30_000; // 30 seconds
const BOT_TIMEOUT_MS = 10_000;

let syncTimer: ReturnType<typeof setTimeout> | null = null;
let prismaClient: PrismaClient | null = null;

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

async function syncOneSlave(
  prisma: PrismaClient,
  slave: Record<string, unknown>,
  masterTrade: Record<string, unknown> | null,
): Promise<void> {
  const userId = slave.earner_user_id as string | null;
  if (!userId) return;

  const activeSlaveTrade = slave.active_slave_trade as Record<string, unknown> | null;

  // Find user's active bot subscription
  const subscription = await prisma.userStrategySubscription.findFirst({
    where: {
      userId,
      isActive: true,
      strategy: { botStrategyType: { not: null } },
    },
    include: {
      strategy: { select: { id: true, botStrategyType: true } },
    },
  });

  if (!subscription) return;

  const strategyId = subscription.strategyId;

  // Find existing OPEN trade for this user+strategy
  const openTrade = await prisma.trade.findFirst({
    where: { userId, strategyId, status: 'OPEN' },
    orderBy: { createdAt: 'desc' },
  });

  if (activeSlaveTrade) {
    // Bot has active trade for this slave
    const netMtm = typeof activeSlaveTrade.net_mtm === 'number'
      ? activeSlaveTrade.net_mtm : 0;
    const grossMtm = typeof activeSlaveTrade.gross_mtm === 'number'
      ? activeSlaveTrade.gross_mtm : 0;
    const callEntry = typeof activeSlaveTrade.call_fill_price === 'number'
      ? activeSlaveTrade.call_fill_price : 0;
    const putEntry = typeof activeSlaveTrade.put_fill_price === 'number'
      ? activeSlaveTrade.put_fill_price : 0;
    const qty = typeof activeSlaveTrade.actual_quantity === 'number'
      ? activeSlaveTrade.actual_quantity : 1;
    const underlying = typeof activeSlaveTrade.underlying === 'string'
      ? activeSlaveTrade.underlying : 'BTC';
    const symbol = `${underlying}-OPTIONS`;

    if (openTrade) {
      // Update existing open trade with latest P&L
      await prisma.trade.update({
        where: { id: openTrade.id },
        data: {
          tradePnl: netMtm,
          pnl: netMtm,
          updatedAt: new Date(),
        },
      });
    } else {
      // Create new OPEN trade record
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
        },
      });
      console.log(`[BotSync] Created OPEN trade for userId=${userId} symbol=${symbol}`);
    }
  } else {
    // Bot has no active trade for this slave
    if (openTrade) {
      // Close the stale open trade
      await prisma.trade.update({
        where: { id: openTrade.id },
        data: {
          status: 'CLOSED',
          exitReason: 'BOT_SYNC_CLOSE',
          exitPrice: 0,
          updatedAt: new Date(),
        },
      });
      console.log(`[BotSync] Closed stale trade for userId=${userId} tradeId=${openTrade.id}`);
    }
  }
}

async function runSyncCycle(prisma: PrismaClient): Promise<void> {
  const overview = await fetchBotOverview();
  if (!overview) return;

  const slaves = Array.isArray(overview.slaves)
    ? (overview.slaves as Record<string, unknown>[])
    : [];

  const masterData = overview.master as Record<string, unknown> | null;
  const masterTrade = masterData?.active_trade as Record<string, unknown> | null ?? null;

  // Only process slaves that have earner_user_id set
  const earnerSlaves = slaves.filter(
    (s) => typeof s.earner_user_id === 'string' && s.earner_user_id,
  );

  if (earnerSlaves.length === 0) return;

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
  prismaClient = prisma;
  console.log('[BotSync] Starting bot P&L sync service (30s interval)');

  async function tick(): Promise<void> {
    try {
      await runSyncCycle(prisma);
    } catch (err) {
      console.warn('[BotSync] Cycle error:', err);
    } finally {
      syncTimer = setTimeout(() => void tick(), POLL_INTERVAL_MS);
    }
  }

  // Start first cycle after 10 seconds (let server fully boot)
  syncTimer = setTimeout(() => void tick(), 10_000);
}

export function stopBotSyncService(): void {
  if (syncTimer) {
    clearTimeout(syncTimer);
    syncTimer = null;
  }
  console.log('[BotSync] Stopped');
}
