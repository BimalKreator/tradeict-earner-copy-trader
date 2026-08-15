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
  _masterTrade: Record<string, unknown> | null,
): Promise<void> {
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

  console.log(
    `[BotSync] syncOneSlave userId=${userId} subscriptionId=${subscriptionId || 'n/a'} ` +
      `activeSlaveTrade=${activeSlaveTrade ? 'yes' : 'no'} ` +
      `slaveTradeId=${activeSlaveTrade?.slave_trade_id ?? 'n/a'}`,
  );

  // Prefer exact subscription id from bot; fall back to user + bot strategy.
  // Do not require isActive alone — ACTIVE status with botStrategyType is enough to sync P&L.
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
    console.warn(
      `[BotSync] No bot subscription for userId=${userId} ` +
        `subscriptionId=${subscriptionId || 'n/a'} ` +
        `(checked id + isActive/ACTIVE + botStrategyType)`,
    );
    return;
  }

  console.log(
    `[BotSync] Found subscription id=${subscription.id} strategyId=${subscription.strategyId} ` +
      `isActive=${subscription.isActive} status=${subscription.status} ` +
      `botStrategyType=${subscription.strategy.botStrategyType}`,
  );

  const strategyId = subscription.strategyId;

  // Find existing OPEN trade for this user+strategy
  const openTrade = await prisma.trade.findFirst({
    where: { userId, strategyId, status: 'OPEN' },
    orderBy: { createdAt: 'desc' },
  });

  console.log(
    `[BotSync] openTrade=${openTrade ? openTrade.id : 'none'} for userId=${userId}`,
  );

  if (activeSlaveTrade) {
    // Bot has active trade for this slave
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
      // Update existing open trade with latest P&L
      await prisma.trade.update({
        where: { id: openTrade.id },
        data: {
          tradePnl: netMtm,
          pnl: netMtm,
          updatedAt: new Date(),
        },
      });
      console.log(
        `[BotSync] Updated OPEN trade id=${openTrade.id} userId=${userId} netMtm=${netMtm}`,
      );
    } else {
      // Create new OPEN trade record
      const created = await prisma.trade.create({
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
      console.log(
        `[BotSync] Created OPEN trade for userId=${userId} symbol=${symbol} ` +
          `tradeId=${created.id} netMtm=${netMtm}`,
      );
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
      console.log(
        `[BotSync] Closed stale trade for userId=${userId} tradeId=${openTrade.id}`,
      );
    } else {
      console.log(
        `[BotSync] No active slave trade and no OPEN earner trade for userId=${userId}`,
      );
    }
  }
}

async function runSyncCycle(prisma: PrismaClient): Promise<void> {
  console.log('[BotSync] Cycle running, fetching overview...');
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

  // Only process slaves that have earner_user_id set
  const earnerSlaves = slaves.filter((s) => {
    const id = s.earner_user_id;
    return typeof id === 'string' && id.trim().length > 0;
  });

  console.log(
    `[BotSync] Overview fetched, slaves count: ${slaves.length}, earner slaves: ${earnerSlaves.length}` +
      ` masterTrade=${masterTrade ? 'yes' : 'no'} keys=${Object.keys(overview).join(',')}`,
  );

  if (earnerSlaves.length === 0) {
    if (slaves.length > 0) {
      const sample = slaves.slice(0, 3).map((s) => ({
        id: s.id,
        name: s.name,
        earner_user_id: s.earner_user_id ?? null,
        has_active: s.active_slave_trade != null,
      }));
      console.warn(
        `[BotSync] No earner slaves (earner_user_id missing). Sample: ${JSON.stringify(sample)}`,
      );
    }
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
