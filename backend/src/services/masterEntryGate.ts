import type { PrismaClient } from "@prisma/client";
import { FUTURE_HEDGE_STRATEGY_TITLE } from "./futureHedgeService.js";
import {
  isBreakevenHedgeEntryLatched,
  isMasterFlatting,
  isPostExitEntryBlocked,
} from "./subscriptionSyncService.js";

/**
 * Unified gate: may the system place new master hedge legs or follower catch-up opens?
 * Checks flatting lock, post-exit cooldown, and breakeven re-arm latch.
 */
export function isMasterEntryFrozen(strategyId: string): boolean {
  return (
    isMasterFlatting(strategyId) ||
    isPostExitEntryBlocked() ||
    isBreakevenHedgeEntryLatched()
  );
}

/** Block fresh hedge entry when breakeven is on and live price is already in the exit zone. */
export async function isBreakevenZoneBlockingHedgeEntry(
  prisma: PrismaClient,
  strategyId: string,
): Promise<boolean> {
  const config = await prisma.futureHedgeConfig.findFirst({
    where: { strategyId },
    select: {
      isBreakevenExitEnabled: true,
      breakevenPrice1: true,
      breakevenPrice2: true,
    },
  });
  if (!config?.isBreakevenExitEnabled) return false;

  const p1 = config.breakevenPrice1;
  const p2 = config.breakevenPrice2;
  const hasP1 = p1 != null && Number.isFinite(p1) && p1 > 0;
  const hasP2 = p2 != null && Number.isFinite(p2) && p2 > 0;
  if (!hasP1 && !hasP2) return false;

  const { evaluateBreakevenPriceBreach, resolveLiveBtcUsdPrice } =
    await import("./autoExitService.js");
  const livePrice = await resolveLiveBtcUsdPrice();
  if (livePrice == null) return false;

  return evaluateBreakevenPriceBreach({
    livePrice,
    breakevenPrice1: hasP1 ? p1 : null,
    breakevenPrice2: hasP2 ? p2 : null,
  });
}

export async function assertMasterHedgeEntryGate(
  prisma: PrismaClient,
  strategy?: { id: string; isActive: boolean },
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const strat =
    strategy ??
    (await prisma.strategy.findFirst({
      where: { title: FUTURE_HEDGE_STRATEGY_TITLE },
      select: { id: true, isActive: true },
    }));
  if (!strat?.isActive) {
    return { ok: false, reason: "strategy paused (isActive=false)" };
  }
  if (isMasterEntryFrozen(strat.id)) {
    if (isMasterFlatting(strat.id)) {
      return {
        ok: false,
        reason: "master flatting lock active — hedge entry blocked",
      };
    }
    if (isPostExitEntryBlocked()) {
      return {
        ok: false,
        reason: "post-exit entry cooldown active — hedge entry blocked",
      };
    }
    if (isBreakevenHedgeEntryLatched()) {
      return {
        ok: false,
        reason: "breakeven re-arm latch active — hedge entry blocked until price is safe",
      };
    }
    return { ok: false, reason: "master entry freeze active" };
  }
  if (await isBreakevenZoneBlockingHedgeEntry(prisma, strat.id)) {
    return {
      ok: false,
      reason: "breakeven exit zone active — hedge entry blocked at current BTC price",
    };
  }
  return { ok: true };
}
