import { Router } from "express";
import { Prisma, InvoiceStatus, Role, UserStatus, } from "@prisma/client";
import { authenticateJwt, requireAdmin, } from "../middleware/authMiddleware.js";
import { fetchCosmicOpenPositions } from "../services/cosmicClient.js";
import { getAdminGroupedLiveTrades } from "../services/liveTradesService.js";
const roleValues = new Set(Object.values(Role));
const statusValues = new Set(Object.values(UserStatus));
function parsePerformanceMetrics(v) {
    if (v === undefined)
        return undefined;
    if (v === null)
        return undefined;
    if (typeof v === "object")
        return v;
    return undefined;
}
export function createAdminRoutes(prisma) {
    const router = Router();
    const adminOnly = [authenticateJwt(), requireAdmin(prisma)];
    router.get("/engine-status", (_req, res) => {
        res.json({ status: "running" });
    });
    router.get("/users", async (_req, res, next) => {
        try {
            const users = await prisma.user.findMany({
                select: {
                    id: true,
                    email: true,
                    role: true,
                    status: true,
                    createdAt: true,
                },
                orderBy: { createdAt: "desc" },
            });
            res.json(users);
        }
        catch (err) {
            next(err);
        }
    });
    router.post("/users", async (req, res, next) => {
        try {
            const { email, password, role, status } = req.body;
            if (typeof email !== "string" || typeof password !== "string") {
                res.status(400).json({ error: "email and password are required" });
                return;
            }
            if (role !== undefined && (typeof role !== "string" || !roleValues.has(role))) {
                res.status(400).json({ error: "role must be ADMIN or USER" });
                return;
            }
            if (status !== undefined &&
                (typeof status !== "string" || !statusValues.has(status))) {
                res.status(400).json({ error: "status must be ACTIVE or SUSPENDED" });
                return;
            }
            const user = await prisma.user.create({
                data: {
                    email,
                    password,
                    ...(role !== undefined ? { role: role } : {}),
                    ...(status !== undefined ? { status: status } : {}),
                },
                select: {
                    id: true,
                    email: true,
                    role: true,
                    status: true,
                    createdAt: true,
                },
            });
            res.status(201).json(user);
        }
        catch (err) {
            next(err);
        }
    });
    router.put("/users/:id", async (req, res, next) => {
        try {
            const { id } = req.params;
            const { status, role } = req.body;
            if (role !== undefined) {
                if (typeof role !== "string" || !roleValues.has(role)) {
                    res.status(400).json({ error: "role must be ADMIN or USER" });
                    return;
                }
            }
            if (status !== undefined) {
                if (typeof status !== "string" || !statusValues.has(status)) {
                    res.status(400).json({ error: "status must be ACTIVE or SUSPENDED" });
                    return;
                }
            }
            if (role === undefined && status === undefined) {
                res.status(400).json({ error: "Provide at least one of status or role" });
                return;
            }
            const data = {};
            if (role !== undefined)
                data.role = role;
            if (status !== undefined)
                data.status = status;
            const user = await prisma.user.update({
                where: { id },
                data,
                select: {
                    id: true,
                    email: true,
                    role: true,
                    status: true,
                    createdAt: true,
                },
            });
            res.json(user);
        }
        catch (err) {
            next(err);
        }
    });
    router.delete("/users/:id", async (req, res, next) => {
        try {
            const { id } = req.params;
            await prisma.user.delete({ where: { id } });
            res.status(204).send();
        }
        catch (err) {
            next(err);
        }
    });
    router.get("/strategies", async (_req, res, next) => {
        try {
            const strategies = await prisma.strategy.findMany({
                orderBy: { createdAt: "desc" },
            });
            const scraperEnvReady = Boolean(process.env.COSMIC_SCRAPER_LOGIN_URL?.trim());
            res.json(strategies.map((s) => {
                const { cosmicPassword, ...rest } = s;
                const hasPwd = Boolean(cosmicPassword?.trim());
                const credPresent = Boolean(s.cosmicEmail?.trim() && hasPwd);
                return {
                    ...rest,
                    hasCosmicPassword: hasPwd,
                    cosmicConnection: {
                        scraperEnvReady,
                        credentialsPresent: credPresent,
                        ready: scraperEnvReady && credPresent,
                    },
                };
            }));
        }
        catch (err) {
            next(err);
        }
    });
    router.post("/strategies", async (req, res, next) => {
        try {
            const body = req.body;
            const title = body.title;
            const description = body.description;
            const cosmicEmail = body.cosmicEmail;
            const slippage = body.slippage;
            const monthlyFee = body.monthlyFee;
            const profitShare = body.profitShare;
            const minCapital = body.minCapital;
            if (typeof title !== "string" ||
                typeof description !== "string" ||
                typeof cosmicEmail !== "string" ||
                typeof monthlyFee !== "number" ||
                typeof minCapital !== "number") {
                res.status(400).json({
                    error: "title, description, cosmicEmail, monthlyFee, and minCapital are required (numbers where applicable)",
                });
                return;
            }
            if (typeof slippage !== "number" || typeof profitShare !== "number") {
                res.status(400).json({
                    error: "slippage and profitShare must be numbers",
                });
                return;
            }
            const cosmicPassword = typeof body.cosmicPassword === "string" ? body.cosmicPassword : "";
            const performanceMetrics = parsePerformanceMetrics(body.performanceMetrics);
            const strategy = await prisma.strategy.create({
                data: {
                    title,
                    description,
                    cosmicEmail,
                    cosmicPassword,
                    ...(performanceMetrics !== undefined
                        ? { performanceMetrics }
                        : {}),
                    slippage,
                    monthlyFee,
                    profitShare,
                    minCapital,
                },
            });
            res.status(201).json(strategy);
        }
        catch (err) {
            next(err);
        }
    });
    router.put("/strategies/:id", async (req, res, next) => {
        try {
            const { id } = req.params;
            const body = req.body;
            const data = {};
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
            if (body.cosmicEmail !== undefined) {
                if (typeof body.cosmicEmail !== "string") {
                    res.status(400).json({ error: "cosmicEmail must be a string" });
                    return;
                }
                data.cosmicEmail = body.cosmicEmail;
            }
            if (body.cosmicPassword !== undefined) {
                if (typeof body.cosmicPassword !== "string") {
                    res.status(400).json({ error: "cosmicPassword must be a string" });
                    return;
                }
                if (body.cosmicPassword !== "") {
                    data.cosmicPassword = body.cosmicPassword;
                }
            }
            if (body.performanceMetrics !== undefined) {
                if (body.performanceMetrics === null) {
                    data.performanceMetrics = Prisma.DbNull;
                }
                else {
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
            if (Object.keys(data).length === 0) {
                res.status(400).json({ error: "No valid fields to update" });
                return;
            }
            const strategy = await prisma.strategy.update({
                where: { id },
                data,
            });
            res.json(strategy);
        }
        catch (err) {
            next(err);
        }
    });
    router.delete("/strategies/:id", async (req, res, next) => {
        try {
            const { id } = req.params;
            await prisma.strategy.delete({ where: { id } });
            res.status(204).send();
        }
        catch (err) {
            next(err);
        }
    });
    router.get("/revenue", ...adminOnly, async (_req, res, next) => {
        try {
            const now = new Date();
            const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
            const [paidAgg, pendingAgg, projectedAgg, invoices,] = await Promise.all([
                prisma.invoice.aggregate({
                    where: { status: InvoiceStatus.PAID },
                    _sum: { amount: true },
                }),
                prisma.invoice.aggregate({
                    where: {
                        status: {
                            in: [InvoiceStatus.UNPAID, InvoiceStatus.OVERDUE],
                        },
                    },
                    _sum: { amount: true },
                }),
                prisma.pnLRecord.aggregate({
                    where: { timestamp: { gte: monthStart } },
                    _sum: { commissionAmount: true },
                }),
                prisma.invoice.findMany({
                    orderBy: { dueDate: "desc" },
                    include: {
                        user: { select: { email: true } },
                    },
                }),
            ]);
            res.json({
                stats: {
                    totalRevenueReceived: paidAgg._sum.amount ?? 0,
                    pendingDuesUnpaid: pendingAgg._sum.amount ?? 0,
                    projectedEarnings: projectedAgg._sum.commissionAmount ?? 0,
                },
                invoices,
            });
        }
        catch (err) {
            next(err);
        }
    });
    /** Same payload as `GET /api/live-trades/admin/grouped` — lives under `/api/admin/*` for proxies that only forward admin API paths. */
    router.get("/live-trades/grouped", ...adminOnly, async (_req, res, next) => {
        try {
            const strategies = await getAdminGroupedLiveTrades(prisma);
            res.json({ strategies });
        }
        catch (err) {
            next(err);
        }
    });
    /**
     * Runs one Puppeteer scrape with stored Cosmic credentials (can take ~30–120s).
     */
    router.post("/strategies/:id/cosmic-probe", ...adminOnly, async (req, res, next) => {
        try {
            const rawId = req.params.id;
            const id = typeof rawId === "string"
                ? rawId
                : Array.isArray(rawId)
                    ? rawId[0]
                    : undefined;
            if (!id) {
                res.status(400).json({ error: "Missing strategy id" });
                return;
            }
            const strategy = await prisma.strategy.findUnique({
                where: { id },
                select: {
                    id: true,
                    title: true,
                    cosmicEmail: true,
                    cosmicPassword: true,
                },
            });
            if (!strategy) {
                res.status(404).json({ error: "Strategy not found" });
                return;
            }
            const scraperEnvReady = Boolean(process.env.COSMIC_SCRAPER_LOGIN_URL?.trim());
            const credentialsPresent = Boolean(strategy.cosmicEmail?.trim() && strategy.cosmicPassword?.trim());
            if (!scraperEnvReady) {
                res.json({
                    ok: false,
                    positionCount: 0,
                    strategyTitle: strategy.title,
                    scraperEnvReady,
                    credentialsPresent,
                    message: "Server is missing COSMIC_SCRAPER_LOGIN_URL. Set it to the Cosmic login page URL and restart the API.",
                });
                return;
            }
            if (!credentialsPresent) {
                res.json({
                    ok: false,
                    positionCount: 0,
                    strategyTitle: strategy.title,
                    scraperEnvReady,
                    credentialsPresent,
                    message: "Save Cosmic Login Email and Password on this strategy before testing.",
                });
                return;
            }
            const positions = await fetchCosmicOpenPositions(strategy.cosmicEmail, strategy.cosmicPassword ?? "");
            res.json({
                ok: true,
                positionCount: positions.length,
                strategyTitle: strategy.title,
                scraperEnvReady,
                credentialsPresent,
                message: positions.length === 0
                    ? "Scrape completed but no positions were parsed. Either there are no open trades, login/selectors failed, or COSMIC_SCRAPER_RESPONSE_FILTER / positions URL does not match Cosmic."
                    : `Parsed ${positions.length} open Cosmic position(s).`,
            });
        }
        catch (err) {
            next(err);
        }
    });
    return router;
}
//# sourceMappingURL=adminRoutes.js.map