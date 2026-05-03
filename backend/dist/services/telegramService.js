import crypto from "node:crypto";
import cron from "node-cron";
import { Telegraf } from "telegraf";
const LINK_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;
let telegram = null;
function utcYesterdayRange() {
    const now = new Date();
    const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    const start = new Date(end);
    start.setUTCDate(start.getUTCDate() - 1);
    return { start, end };
}
export async function notifyTradeExecuted(prisma, args) {
    if (!telegram)
        return;
    const user = await prisma.user.findUnique({
        where: { id: args.userId },
        select: { telegramChatId: true },
    });
    if (!user?.telegramChatId)
        return;
    const strat = await prisma.strategy.findUnique({
        where: { id: args.strategyId },
        select: { title: true },
    });
    const lines = [
        "📈 New trade executed",
        `Strategy: ${strat?.title ?? args.strategyId}`,
        `${args.symbol} ${args.side}`,
        `Size: ${args.size}`,
        `Entry: ${args.entryPrice}`,
    ];
    try {
        await telegram.sendMessage(user.telegramChatId, lines.join("\n"));
    }
    catch (err) {
        console.warn("[telegram] notifyTradeExecuted failed:", err);
    }
}
export async function sendDailyPnLSummaries(prisma) {
    if (!telegram)
        return;
    const { start, end } = utcYesterdayRange();
    const grouped = await prisma.pnLRecord.groupBy({
        by: ["userId"],
        where: {
            timestamp: {
                gte: start,
                lt: end,
            },
        },
        _sum: {
            profitAmount: true,
            commissionAmount: true,
        },
    });
    const dateLabel = start.toISOString().slice(0, 10);
    for (const row of grouped) {
        const user = await prisma.user.findUnique({
            where: { id: row.userId },
            select: { telegramChatId: true, email: true },
        });
        if (!user?.telegramChatId)
            continue;
        const gross = row._sum.profitAmount ?? 0;
        const commission = row._sum.commissionAmount ?? 0;
        const lines = [
            `📊 Daily PnL summary (${dateLabel} UTC)`,
            `Gross PnL: ${gross.toFixed(2)}`,
            `Commission (est.): ${commission.toFixed(2)}`,
            `Net after commission: ${(gross - commission).toFixed(2)}`,
        ];
        try {
            await telegram.sendMessage(user.telegramChatId, lines.join("\n"));
        }
        catch (err) {
            console.warn(`[telegram] daily summary failed for ${user.email}:`, err);
        }
    }
}
export function initTelegramCronJobs(prisma) {
    if (!process.env.TELEGRAM_BOT_TOKEN?.trim()) {
        return;
    }
    cron.schedule("5 0 * * *", () => {
        void sendDailyPnLSummaries(prisma).catch((err) => {
            console.error("[telegram] daily PnL cron failed:", err);
        });
    }, { timezone: "Etc/UTC" });
    console.log("[telegram] Cron: daily PnL summaries at 00:05 UTC");
}
export function initTelegramBot(prisma) {
    const token = process.env.TELEGRAM_BOT_TOKEN?.trim();
    if (!token) {
        console.warn("[telegram] TELEGRAM_BOT_TOKEN not set; bot and outbound alerts disabled");
        return;
    }
    const bot = new Telegraf(token);
    telegram = bot.telegram;
    bot.start(async (ctx) => {
        try {
            const raw = ctx.message &&
                "text" in ctx.message &&
                typeof ctx.message.text === "string"
                ? ctx.message.text.replace(/^\/start\s*/i, "").trim()
                : "";
            const chatId = ctx.chat?.id;
            if (chatId === undefined)
                return;
            const chatIdStr = String(chatId);
            if (!raw) {
                await ctx.reply([
                    "Welcome to TradeICT alerts.",
                    "",
                    "Link your account: open TradeICT → Settings → generate a Telegram link, then send:",
                    "/start YOUR_CODE_HERE",
                ].join("\n"));
                return;
            }
            const now = new Date();
            const pendingUser = await prisma.user.findFirst({
                where: {
                    telegramLinkToken: raw,
                    telegramLinkExpires: { gt: now },
                },
            });
            if (!pendingUser) {
                await ctx.reply("Invalid or expired link code. Generate a new code from TradeICT (Settings).");
                return;
            }
            await prisma.$transaction([
                prisma.user.updateMany({
                    where: {
                        telegramChatId: chatIdStr,
                        NOT: { id: pendingUser.id },
                    },
                    data: {
                        telegramChatId: null,
                    },
                }),
                prisma.user.update({
                    where: { id: pendingUser.id },
                    data: {
                        telegramChatId: chatIdStr,
                        telegramLinkToken: null,
                        telegramLinkExpires: null,
                    },
                }),
            ]);
            await ctx.reply(`✅ Linked to TradeICT account ${pendingUser.email}. You will receive trade alerts and daily PnL summaries here.`);
        }
        catch (err) {
            console.error("[telegram] /start handler failed:", err);
            try {
                await ctx.reply("Something went wrong. Try again later.");
            }
            catch {
                /* ignore */
            }
        }
    });
    void bot
        .launch()
        .then(() => {
        console.log("[telegram] Bot polling started");
    })
        .catch((err) => {
        console.error("[telegram] bot.launch failed:", err);
        telegram = null;
    });
    process.once("SIGINT", () => bot.stop("SIGINT"));
    process.once("SIGTERM", () => bot.stop("SIGTERM"));
}
export function createTelegramLinkToken() {
    return crypto.randomBytes(16).toString("hex");
}
export function telegramLinkExpiry() {
    return new Date(Date.now() + LINK_TOKEN_TTL_MS);
}
//# sourceMappingURL=telegramService.js.map