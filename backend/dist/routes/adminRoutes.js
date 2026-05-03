import { Router } from "express";
import { Prisma, InvoiceStatus, Role, UserStatus, } from "@prisma/client";
import { PrismaClientKnownRequestError } from "@prisma/client/runtime/client";
import { authenticateToken, isAdmin } from "../middleware/authMiddleware.js";
import { probeCosmicOpenPositions } from "../services/cosmicClient.js";
import { getAdminGroupedLiveTrades } from "../services/liveTradesService.js";
import { runScraperStudioInspect } from "../services/scraperStudioInspect.js";
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
    router.use(authenticateToken(), isAdmin(prisma));
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
            /** Body `null` → clear column (`Prisma.DbNull` at update); object replaces mappings. */
            let scraperMappingsPatch;
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
            const mappingsBody = body.scraperMappings !== undefined
                ? body.scraperMappings
                : body.scraperStudioSelectors;
            if (mappingsBody !== undefined) {
                if (mappingsBody === null) {
                    scraperMappingsPatch = null;
                }
                else if (typeof mappingsBody === "object" &&
                    mappingsBody !== null &&
                    !Array.isArray(mappingsBody)) {
                    const raw = mappingsBody;
                    const cleaned = {};
                    for (const [k, v] of Object.entries(raw)) {
                        if (typeof k !== "string" || typeof v !== "string") {
                            res.status(400).json({
                                error: "scraperMappings must be an object with string keys and string selector values",
                            });
                            return;
                        }
                        const key = k.trim();
                        if (!key)
                            continue;
                        cleaned[key] = v;
                    }
                    scraperMappingsPatch = cleaned;
                }
                else {
                    res.status(400).json({
                        error: "scraperMappings must be a JSON object or null to clear (legacy key scraperStudioSelectors still accepted)",
                    });
                    return;
                }
            }
            if (Object.keys(data).length === 0 &&
                scraperMappingsPatch === undefined) {
                res.status(400).json({ error: "No valid fields to update" });
                return;
            }
            try {
                const strategy = await prisma.strategy.update({
                    where: { id },
                    data: {
                        ...data,
                        ...(scraperMappingsPatch !== undefined
                            ? {
                                scraperMappings: scraperMappingsPatch === null
                                    ? Prisma.DbNull
                                    : scraperMappingsPatch,
                            }
                            : {}),
                    },
                });
                const { cosmicPassword: _omitPwd, ...safe } = strategy;
                res.json(safe);
            }
            catch (err) {
                if (err instanceof PrismaClientKnownRequestError &&
                    err.code === "P2025") {
                    res.status(404).json({ error: "Strategy not found" });
                    return;
                }
                return next(err);
            }
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
    router.get("/revenue", async (_req, res, next) => {
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
    router.get("/live-trades/grouped", async (_req, res, next) => {
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
    router.post("/strategies/:id/cosmic-probe", async (req, res, next) => {
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
                    scraperMappings: true,
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
            const captureScreenshot = process.env.COSMIC_SCRAPER_PROBE_SCREENSHOT === "true";
            const { trades: positions, screenshotBase64, scrapeMeta } = await probeCosmicOpenPositions(strategy.cosmicEmail, strategy.cosmicPassword ?? "", captureScreenshot, strategy.scraperMappings);
            let message;
            if (positions.length > 0) {
                message = `Parsed ${positions.length} open Cosmic position(s).`;
            }
            else if (scrapeMeta?.scrapeAbortedReason) {
                message = `Browser scrape aborted: ${scrapeMeta.scrapeAbortedReason}`;
            }
            else if (scrapeMeta?.extractError) {
                message = `Portfolio DOM extract error: ${scrapeMeta.extractError}`;
            }
            else if (scrapeMeta !== undefined &&
                scrapeMeta.domRowsMatched > 0 &&
                scrapeMeta.domPositionsParsed === 0) {
                message =
                    `Found ${scrapeMeta.domRowsMatched} position row(s) in the page DOM but field parsing yielded 0 positions — markup may have changed (symbol/side/size/avg columns).`;
            }
            else if (scrapeMeta !== undefined &&
                scrapeMeta.domRowsMatched === 0 &&
                scrapeMeta.walletBalanceDom) {
                message =
                    "Portfolio wallet loaded but no position rows matched selectors — scroll/tab issue or Cosmic layout changed; check COSMIC_SCRAPER_PROBE_SCREENSHOT and API logs.";
            }
            else if (scrapeMeta !== undefined &&
                scrapeMeta.domRowsMatched === 0 &&
                !scrapeMeta.walletBalanceDom) {
                message =
                    "No wallet row or position rows detected — login likely failed (wrong credentials, 2FA, or selectors). Confirm COSMIC_SCRAPER_LOGIN_URL and strategy Cosmic username/password.";
            }
            else {
                message =
                    "Scrape finished but no position payloads were produced — DOM extract may have failed; check API logs for [cosmic-scraper].";
            }
            res.json({
                ok: true,
                positionCount: positions.length,
                strategyTitle: strategy.title,
                scraperEnvReady,
                credentialsPresent,
                screenshotPreview: Boolean(screenshotBase64),
                screenshotBase64: screenshotBase64 ?? undefined,
                scrapeMeta: scrapeMeta ?? undefined,
                message,
            });
        }
        catch (err) {
            next(err);
        }
    });
    /**
     * Visual Scraper Studio: headless inspect — screenshot + visible element boxes/selectors.
     * Body: `{ url, strategyId?, email?, password? }` — if `strategyId` is set, Cosmic credentials load server-side.
     */
    router.post("/scraper-studio/inspect", async (req, res, next) => {
        try {
            const { url, email, password, strategyId } = req.body;
            if (typeof url !== "string" || !url.trim()) {
                res.status(400).json({ error: "url is required" });
                return;
            }
            let emailStr = typeof email === "string" ? email : "";
            let passwordStr = typeof password === "string" ? password : "";
            if (typeof strategyId === "string" && strategyId.trim()) {
                const strat = await prisma.strategy.findUnique({
                    where: { id: strategyId.trim() },
                    select: { cosmicEmail: true, cosmicPassword: true },
                });
                if (!strat) {
                    res.status(404).json({ error: "Strategy not found" });
                    return;
                }
                emailStr = strat.cosmicEmail ?? "";
                passwordStr = strat.cosmicPassword ?? "";
            }
            const result = await runScraperStudioInspect({
                url: url.trim(),
                email: emailStr,
                password: passwordStr,
            });
            res.json(result);
        }
        catch (err) {
            next(err);
        }
    });
    return router;
}
//# sourceMappingURL=adminRoutes.js.map