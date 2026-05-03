import { addExtra } from "puppeteer-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import vanillaPuppeteer from "puppeteer";
import { SubscriptionStatus, TradeStatus, UserStatus, } from "@prisma/client";
import { executeTrade, fetchDeltaTicker, } from "./exchangeService.js";
import { recordTradePnl } from "../controllers/subscriptionController.js";
import { notifyTradeExecuted } from "./telegramService.js";
import { logUserActivity } from "./userActivityService.js";
/** Puppeteer v24 typings omit legacy helpers expected by puppeteer-extra; runtime is fine. */
const puppeteer = addExtra(vanillaPuppeteer);
puppeteer.use(StealthPlugin());
const POLL_MIN_MS = 2000;
const POLL_MAX_MS = 3000;
function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
function randomPollMs() {
    return (POLL_MIN_MS +
        Math.floor(Math.random() * (POLL_MAX_MS - POLL_MIN_MS + 1)));
}
function normalizeSide(raw) {
    const u = raw.trim().toUpperCase();
    if (u === "BUY" || u === "LONG")
        return "BUY";
    if (u === "SELL" || u === "SHORT")
        return "SELL";
    return null;
}
function buildTradeId(parts) {
    return `${parts.symbol}|${parts.side}|${parts.entryPrice}|${parts.size}`;
}
function percentSlippage(entry, market) {
    if (entry <= 0)
        return Number.POSITIVE_INFINITY;
    return (Math.abs(market - entry) / entry) * 100;
}
async function recordTrade(prisma, args) {
    await prisma.trade.create({
        data: {
            userId: args.userId,
            strategyId: args.strategyId,
            symbol: args.symbol,
            side: args.side,
            size: args.size,
            entryPrice: args.entryPrice,
            status: args.status,
            ...(args.exitPrice != null ? { exitPrice: args.exitPrice } : {}),
            ...(args.pnl != null ? { pnl: args.pnl } : {}),
        },
    });
    if (args.status === TradeStatus.CLOSED &&
        args.pnl != null &&
        Number.isFinite(args.pnl)) {
        await recordTradePnl(prisma, {
            userId: args.userId,
            strategyId: args.strategyId,
            tradeProfit: args.pnl,
        });
    }
    if (args.status === TradeStatus.OPEN) {
        void notifyTradeExecuted(prisma, {
            userId: args.userId,
            strategyId: args.strategyId,
            symbol: args.symbol,
            side: args.side,
            size: args.size,
            entryPrice: args.entryPrice,
        }).catch((err) => {
            console.warn("[telegram] notifyTradeExecuted:", err);
        });
    }
    if (args.status === TradeStatus.FAILED) {
        void logUserActivity(prisma, {
            userId: args.userId,
            kind: "TRADE_SKIPPED",
            message: `Trade skipped: ${args.symbol} ${args.side} @ ${args.entryPrice} (size ${args.size})`,
        });
    }
}
function realizedPnlUsd(args) {
    const diff = args.exitPrice - args.entryPrice;
    return args.side === "BUY" ? diff * args.size : -diff * args.size;
}
function entryPriceMatches(stored, cosmic) {
    const eps = Math.max(1e-8, Math.abs(cosmic) * 1e-6);
    return Math.abs(stored - cosmic) <= eps;
}
/**
 * Marks the follower's matching OPEN trade CLOSED and writes PnL + commission row.
 */
async function closeFollowerTradeAndRecordPnl(prisma, args) {
    const candidates = await prisma.trade.findMany({
        where: {
            userId: args.userId,
            strategyId: args.strategyId,
            symbol: args.cosmic.symbol,
            side: args.cosmic.side,
            status: TradeStatus.OPEN,
        },
        orderBy: { createdAt: "asc" },
    });
    const open = candidates.find((t) => entryPriceMatches(t.entryPrice, args.cosmic.entryPrice));
    if (!open)
        return;
    const tradeProfit = realizedPnlUsd({
        side: args.cosmic.side,
        entryPrice: args.cosmic.entryPrice,
        exitPrice: args.exitPrice,
        size: args.sizedPosition,
    });
    await prisma.trade.update({
        where: { id: open.id },
        data: {
            exitPrice: args.exitPrice,
            pnl: tradeProfit,
            status: TradeStatus.CLOSED,
        },
    });
    await recordTradePnl(prisma, {
        userId: args.userId,
        strategyId: args.strategyId,
        tradeProfit,
    });
}
async function processRemovedCosmicPositions(prisma, strategies, removed) {
    for (const cosmic of removed) {
        let exitPrice;
        try {
            const t = await fetchDeltaTicker(cosmic.symbol);
            exitPrice = t.last;
        }
        catch {
            exitPrice = undefined;
        }
        if (exitPrice === undefined || !Number.isFinite(exitPrice))
            continue;
        for (const strategy of strategies) {
            const subs = await prisma.userSubscription.findMany({
                where: {
                    strategyId: strategy.id,
                    status: SubscriptionStatus.ACTIVE,
                    user: { status: UserStatus.ACTIVE },
                },
            });
            for (const sub of subs) {
                const userSize = cosmic.size * sub.multiplier;
                await closeFollowerTradeAndRecordPnl(prisma, {
                    userId: sub.userId,
                    strategyId: strategy.id,
                    cosmic,
                    sizedPosition: userSize,
                    exitPrice,
                });
            }
        }
    }
}
async function processNewCosmicTrade(prisma, strategy, cosmic) {
    let marketPrice;
    try {
        const t = await fetchDeltaTicker(cosmic.symbol);
        marketPrice = t.last;
    }
    catch {
        marketPrice = undefined;
    }
    const subs = await prisma.userSubscription.findMany({
        where: {
            strategyId: strategy.id,
            status: SubscriptionStatus.ACTIVE,
            user: { status: UserStatus.ACTIVE },
        },
        include: {
            user: {
                include: { deltaApiKeys: true },
            },
        },
    });
    if (marketPrice !== undefined &&
        percentSlippage(cosmic.entryPrice, marketPrice) > strategy.slippage) {
        console.log("Slippage Exceeded");
        for (const sub of subs) {
            const userSize = cosmic.size * sub.multiplier;
            await recordTrade(prisma, {
                userId: sub.userId,
                strategyId: strategy.id,
                symbol: cosmic.symbol,
                side: cosmic.side,
                size: userSize,
                entryPrice: cosmic.entryPrice,
                status: TradeStatus.FAILED,
            });
        }
        return;
    }
    if (marketPrice === undefined) {
        for (const sub of subs) {
            const userSize = cosmic.size * sub.multiplier;
            await recordTrade(prisma, {
                userId: sub.userId,
                strategyId: strategy.id,
                symbol: cosmic.symbol,
                side: cosmic.side,
                size: userSize,
                entryPrice: cosmic.entryPrice,
                status: TradeStatus.FAILED,
            });
        }
        return;
    }
    for (const sub of subs) {
        const userSize = cosmic.size * sub.multiplier;
        const keyRow = sub.user.deltaApiKeys[0];
        if (!keyRow) {
            await recordTrade(prisma, {
                userId: sub.userId,
                strategyId: strategy.id,
                symbol: cosmic.symbol,
                side: cosmic.side,
                size: userSize,
                entryPrice: cosmic.entryPrice,
                status: TradeStatus.FAILED,
            });
            continue;
        }
        const result = await executeTrade(keyRow.apiKey, keyRow.apiSecret, cosmic.symbol, cosmic.side, userSize);
        await recordTrade(prisma, {
            userId: sub.userId,
            strategyId: strategy.id,
            symbol: cosmic.symbol,
            side: cosmic.side,
            size: userSize,
            entryPrice: cosmic.entryPrice,
            status: result.success ? TradeStatus.OPEN : TradeStatus.FAILED,
        });
    }
}
/** Prefer last row in DOM order — UIs often list newest positions at the bottom. */
function pickLatestTrade(trades) {
    if (trades.length === 0)
        return null;
    return trades[trades.length - 1];
}
/**
 * Scrape Open Positions via DOM. Selectors are configurable — if the site layout
 * changes, update env vars or this evaluate logic without crashing the loop.
 */
async function scrapeOpenPositions(page) {
    const tableSelector = process.env.COSMIC_SEL_POSITIONS_TABLE ?? '[data-testid="open-positions"]';
    const rowSelector = process.env.COSMIC_SEL_POSITION_ROW ?? "tbody tr";
    const colSymbol = Number(process.env.COSMIC_COL_SYMBOL ?? "0");
    const colSide = Number(process.env.COSMIC_COL_SIDE ?? "1");
    const colEntry = Number(process.env.COSMIC_COL_ENTRY ?? "2");
    const colSize = Number(process.env.COSMIC_COL_SIZE ?? "3");
    let raw;
    try {
        raw = await page.evaluate((cfg) => {
            try {
                const root = document.querySelector(cfg.tableSelector);
                if (!root) {
                    return {
                        ok: false,
                        error: `POSITIONS_TABLE_NOT_FOUND:${cfg.tableSelector}`,
                    };
                }
                const trs = Array.from(root.querySelectorAll(cfg.rowSelector)).filter((el) => el.tagName === "TR");
                const rows = [];
                for (const tr of trs) {
                    const cells = Array.from(tr.querySelectorAll("th, td"));
                    const text = (i) => (cells[i]?.textContent ?? "").trim();
                    const symbol = text(cfg.colSymbol);
                    const sideRaw = text(cfg.colSide);
                    const entryRaw = text(cfg.colEntry).replace(/,/g, "");
                    const sizeRaw = text(cfg.colSize).replace(/,/g, "");
                    const entry = Number.parseFloat(entryRaw);
                    const size = Number.parseFloat(sizeRaw);
                    if (!symbol ||
                        !sideRaw ||
                        Number.isNaN(entry) ||
                        Number.isNaN(size)) {
                        continue;
                    }
                    rows.push({ symbol, side: sideRaw, entry, size });
                }
                return { ok: true, rows };
            }
            catch (e) {
                return {
                    ok: false,
                    error: e instanceof Error ? e.message : `evaluate_error:${String(e)}`,
                };
            }
        }, {
            tableSelector,
            rowSelector,
            colSymbol,
            colSide,
            colEntry,
            colSize,
        });
    }
    catch (err) {
        console.warn("[tradeEngine] page.evaluate failed:", err instanceof Error ? err.message : err);
        return [];
    }
    if (!raw.ok) {
        console.warn(`[tradeEngine] scrape skipped (DOM): ${raw.error}. Adjust COSMIC_SEL_* / COSMIC_COL_* in .env.`);
        return [];
    }
    const trades = [];
    for (const row of raw.rows) {
        const side = normalizeSide(row.side);
        if (!side)
            continue;
        const id = buildTradeId({
            symbol: row.symbol,
            side,
            entryPrice: row.entry,
            size: row.size,
        });
        trades.push({
            id,
            symbol: row.symbol,
            side,
            size: row.size,
            entryPrice: row.entry,
        });
    }
    return trades;
}
async function performLogin(page) {
    const loginUrl = process.env.COSMIC_LOGIN_URL ??
        "https://cosmic.trade/login";
    const email = process.env.COSMIC_EMAIL;
    const password = process.env.COSMIC_PASSWORD;
    if (!email || !password) {
        throw new Error("COSMIC_EMAIL and COSMIC_PASSWORD are required");
    }
    const selEmail = process.env.COSMIC_SEL_EMAIL ?? 'input[type="email"], input[name="email"], #email';
    const selPassword = process.env.COSMIC_SEL_PASSWORD ??
        'input[type="password"], input[name="password"], #password';
    const selLogin = process.env.COSMIC_SEL_LOGIN ??
        'button[type="submit"], button[data-action="login"], .login-button';
    await page.goto(loginUrl, {
        waitUntil: "networkidle2",
        timeout: 90_000,
    });
    await page.waitForSelector(selEmail, { timeout: 45_000 });
    await page.waitForSelector(selPassword, { timeout: 45_000 });
    await page.click(selEmail, { clickCount: 3 }).catch(() => { });
    await page.type(selEmail, email, { delay: 15 });
    await page.click(selPassword, { clickCount: 3 }).catch(() => { });
    await page.type(selPassword, password, { delay: 15 });
    await Promise.all([
        page.waitForNavigation({ waitUntil: "networkidle2", timeout: 90_000 }),
        page.click(selLogin),
    ]);
}
async function openPositionsPage(page) {
    const url = process.env.COSMIC_OPEN_POSITIONS_URL ??
        process.env.COSMIC_PORTFOLIO_URL ??
        process.env.COSMIC_TERMINAL_URL ??
        "https://cosmic.trade/portfolio";
    await page.goto(url, {
        waitUntil: "networkidle2",
        timeout: 90_000,
    });
}
async function runEngineLoop(prisma, page, cancelled, dedupe) {
    while (!cancelled.value) {
        try {
            const scraped = await scrapeOpenPositions(page);
            const currentOpen = new Map(scraped.map((t) => [t.id, t]));
            const removed = [];
            for (const [id, trade] of dedupe.prevOpenById) {
                if (!currentOpen.has(id)) {
                    removed.push(trade);
                }
            }
            if (removed.length > 0) {
                const strategiesForClose = await prisma.strategy.findMany({
                    where: {
                        subscriptions: {
                            some: { status: SubscriptionStatus.ACTIVE },
                        },
                    },
                });
                await processRemovedCosmicPositions(prisma, strategiesForClose, removed);
            }
            dedupe.prevOpenById = currentOpen;
            const latest = pickLatestTrade(scraped);
            if (!latest) {
                await sleep(randomPollMs());
                continue;
            }
            if (dedupe.lastId === undefined) {
                dedupe.lastId = latest.id;
                await sleep(randomPollMs());
                continue;
            }
            if (latest.id === dedupe.lastId) {
                await sleep(randomPollMs());
                continue;
            }
            const strategies = await prisma.strategy.findMany({
                where: {
                    subscriptions: {
                        some: { status: SubscriptionStatus.ACTIVE },
                    },
                },
            });
            if (strategies.length === 0) {
                dedupe.lastId = latest.id;
                await sleep(randomPollMs());
                continue;
            }
            for (const strategy of strategies) {
                try {
                    await processNewCosmicTrade(prisma, strategy, latest);
                }
                catch (err) {
                    console.error(`[tradeEngine] strategy ${strategy.id} copy failed:`, err);
                }
            }
            dedupe.lastId = latest.id;
        }
        catch (err) {
            console.error("[tradeEngine] loop iteration failed:", err);
        }
        await sleep(randomPollMs());
    }
}
/**
 * Logs into Cosmic.trade via stealth Puppeteer, scrapes Open Positions every 2–3s,
 * and mirrors new trades to Delta for subscribers. Returns a disposer that closes the browser.
 */
export function startTradeEngine(prisma) {
    const cancelled = { value: false };
    const dedupe = {
        lastId: undefined,
        prevOpenById: new Map(),
    };
    void (async () => {
        let browser;
        try {
            const launched = await puppeteer.launch({
                headless: true,
                args: ["--no-sandbox", "--disable-setuid-sandbox"],
            });
            browser = launched;
            const page = await launched.newPage();
            await page.setViewport({ width: 1280, height: 900 });
            await performLogin(page);
            await openPositionsPage(page);
            await runEngineLoop(prisma, page, cancelled, dedupe);
        }
        catch (err) {
            console.error("[tradeEngine] fatal:", err);
        }
        finally {
            await browser?.close().catch(() => { });
        }
    })();
    return () => {
        cancelled.value = true;
    };
}
//# sourceMappingURL=tradeEngine.js.map