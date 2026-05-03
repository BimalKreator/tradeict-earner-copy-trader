import { SubscriptionStatus, TradeStatus, UserStatus, } from "@prisma/client";
import { fetchCosmicOpenPositions, } from "./cosmicClient.js";
import { fetchDeltaOpenPositions, fetchDeltaTicker, } from "./exchangeService.js";
function compactSymbolKey(s) {
    return s.replace(/[/:]/g, "").toUpperCase();
}
function symbolsAlign(tradeSymbol, positionKey) {
    const a = compactSymbolKey(tradeSymbol);
    const b = compactSymbolKey(positionKey);
    return a === b || a.endsWith(b) || b.endsWith(a);
}
function sidesAlign(tradeSide, posSide) {
    const t = tradeSide.toUpperCase();
    return t === posSide;
}
function matchDeltaPosition(positions, tradeSymbol, tradeSide) {
    return positions.find((p) => symbolsAlign(tradeSymbol, p.symbolKey) && sidesAlign(tradeSide, p.side));
}
function cosmicToRow(c) {
    return {
        entryTime: c.openedAt ?? null,
        token: c.deltaSymbol,
        entryPrice: c.entryPrice,
        stopLoss: c.stopLoss ?? null,
        target: c.takeProfit ?? null,
        livePnl: null,
        markPrice: null,
        side: c.side,
    };
}
function deltaToRow(p) {
    return {
        entryTime: p.entryTime,
        token: p.symbolKey,
        entryPrice: p.entryPrice,
        stopLoss: p.stopLoss,
        target: p.takeProfit,
        livePnl: p.unrealizedPnl,
        markPrice: p.markPrice,
        side: p.side,
    };
}
function estimateCosmicPnl(c, mark) {
    if (mark === null || !Number.isFinite(mark))
        return null;
    const diff = mark - c.entryPrice;
    const signed = c.side === "BUY" ? diff : -diff;
    return signed * c.size;
}
export async function getUserLiveTradeRows(prisma, userId) {
    const openTrades = await prisma.trade.findMany({
        where: { userId, status: TradeStatus.OPEN },
        include: {
            strategy: { select: { id: true, title: true } },
        },
        orderBy: { createdAt: "desc" },
    });
    const subs = await prisma.userSubscription.findMany({
        where: {
            userId,
            status: SubscriptionStatus.ACTIVE,
            user: { status: UserStatus.ACTIVE },
        },
        include: { exchangeAccount: true },
    });
    const strategyToAccount = new Map();
    for (const s of subs) {
        if (!s.exchangeAccount)
            continue;
        if (!strategyToAccount.has(s.strategyId)) {
            strategyToAccount.set(s.strategyId, {
                id: s.exchangeAccount.id,
                apiKey: s.exchangeAccount.apiKey,
                apiSecret: s.exchangeAccount.apiSecret,
            });
        }
    }
    const positionsCache = new Map();
    async function positionsForStrategy(strategyId) {
        const creds = strategyToAccount.get(strategyId);
        if (!creds)
            return [];
        const hit = positionsCache.get(creds.id);
        if (hit)
            return hit;
        try {
            const list = await fetchDeltaOpenPositions(creds.apiKey, creds.apiSecret);
            positionsCache.set(creds.id, list);
            return list;
        }
        catch {
            positionsCache.set(creds.id, []);
            return [];
        }
    }
    const rows = [];
    for (const t of openTrades) {
        const positions = await positionsForStrategy(t.strategyId);
        const match = matchDeltaPosition(positions, t.symbol, t.side);
        let markPrice = match?.markPrice ?? null;
        let livePnl = match?.unrealizedPnl ?? null;
        let stopLoss = match?.stopLoss ?? null;
        let target = match?.takeProfit ?? null;
        let entryTime = match?.entryTime ?? t.createdAt.toISOString();
        if (match) {
            entryTime = match.entryTime ?? entryTime;
        }
        else {
            try {
                const tick = await fetchDeltaTicker(t.symbol);
                if (tick.last !== undefined && Number.isFinite(tick.last)) {
                    markPrice = tick.last;
                    const entry = t.entryPrice;
                    const diff = markPrice - entry;
                    const signed = t.side.toUpperCase() === "BUY" ? diff : -diff;
                    livePnl = signed * t.size;
                }
            }
            catch {
                /* ignore */
            }
            entryTime = t.createdAt.toISOString();
        }
        rows.push({
            strategyId: t.strategy.id,
            strategyTitle: t.strategy.title,
            entryTime,
            token: t.symbol,
            entryPrice: t.entryPrice,
            stopLoss,
            target,
            livePnl,
            markPrice,
            side: t.side,
        });
    }
    return rows;
}
export async function getAdminGroupedLiveTrades(prisma) {
    const strategies = await prisma.strategy.findMany({
        orderBy: { createdAt: "desc" },
        select: {
            id: true,
            title: true,
            cosmicEmail: true,
            cosmicPassword: true,
        },
    });
    const out = [];
    const followerPositionsCache = new Map();
    for (const strat of strategies) {
        let cosmicList = [];
        try {
            cosmicList = await fetchCosmicOpenPositions(strat.cosmicEmail, strat.cosmicPassword);
        }
        catch {
            cosmicList = [];
        }
        const subs = await prisma.userSubscription.findMany({
            where: {
                strategyId: strat.id,
                status: SubscriptionStatus.ACTIVE,
                user: { status: UserStatus.ACTIVE },
            },
            include: {
                user: { select: { email: true } },
                exchangeAccount: true,
            },
        });
        async function followerPositions(accountId, apiKey, apiSecret) {
            const hit = followerPositionsCache.get(accountId);
            if (hit)
                return hit;
            try {
                const list = await fetchDeltaOpenPositions(apiKey, apiSecret);
                followerPositionsCache.set(accountId, list);
                return list;
            }
            catch {
                followerPositionsCache.set(accountId, []);
                return [];
            }
        }
        const groups = [];
        if (cosmicList.length === 0) {
            out.push({ strategyId: strat.id, strategyTitle: strat.title, groups });
            continue;
        }
        for (const c of cosmicList) {
            let mark = null;
            try {
                const tick = await fetchDeltaTicker(c.deltaSymbol);
                mark = tick.last ?? null;
            }
            catch {
                mark = null;
            }
            const cosmicRow = {
                ...cosmicToRow(c),
                markPrice: mark,
                livePnl: estimateCosmicPnl(c, mark),
            };
            const followers = [];
            for (const sub of subs) {
                if (!sub.exchangeAccount)
                    continue;
                const positions = await followerPositions(sub.exchangeAccount.id, sub.exchangeAccount.apiKey, sub.exchangeAccount.apiSecret);
                const m = matchDeltaPosition(positions, c.deltaSymbol, c.side);
                if (!m)
                    continue;
                followers.push({
                    userEmail: sub.user.email,
                    ...deltaToRow(m),
                });
            }
            groups.push({ cosmic: cosmicRow, followers });
        }
        out.push({
            strategyId: strat.id,
            strategyTitle: strat.title,
            groups,
        });
    }
    return out;
}
//# sourceMappingURL=liveTradesService.js.map