import type { NextFunction, Request, Response } from "express";
import { Prisma, type PrismaClient } from "@prisma/client";
import {
  getRequestIp,
  logAdminAction,
  logAdminActionOrThrow,
} from "../utils/auditLogger.js";

const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/** Body keys whose values must never enter AdminAuditLog (case-insensitive, ignore _/-). */
const REDACT_KEYS = new Set([
  "apikey",
  "apisecret",
  "masterapikey",
  "masterapisecret",
  "password",
  "token",
  "secret",
  "otp",
]);

/**
 * Paths where a failed audit write must abort the request (money / positions).
 * Compared against a normalized path template (`:id` for UUID/cuid segments).
 */
export const MONEY_CRITICAL_PATHS: readonly string[] = [
  "/payouts/:id/complete",
  "/revenue/user/:id/profit-share",
  "/users/:id/close-structure-and-finalise-billing",
  "/trades/flush-all",
  "/users/flush-trades",
  "/users/:id/trades/flush",
  "/wallet/users/:id/adjust",
  "/wallet/withdrawals/:id/process",
  "/debug/inject-trade",
  "/debug/inject-dummy-trade",
  "/debug/clear-dummy-trades",
  "/simulate/purge",
  "/users/:id/api-keys",
  "/live-trades/close-all",
] as const;

const MONEY_CRITICAL_SET = new Set(
  MONEY_CRITICAL_PATHS.map((p) => p.toLowerCase()),
);

function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[_-]/g, "");
}

/** Replace UUID / cuid path segments with `:id` for stable action labels. */
export function normalizeAdminPathTemplate(path: string): string {
  const cleaned = (path.split("?")[0] ?? path).replace(/\/+/g, "/");
  const trimmed =
    cleaned.length > 1 && cleaned.endsWith("/") ? cleaned.slice(0, -1) : cleaned;
  return trimmed.replace(
    /\/([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|[a-z0-9]{20,})/gi,
    "/:id",
  );
}

export function isMoneyCriticalPath(path: string): boolean {
  const template = normalizeAdminPathTemplate(path).toLowerCase();
  return MONEY_CRITICAL_SET.has(template);
}

export function sanitizeAuditValue(value: unknown, depth = 0): unknown {
  if (depth > 8) return "[truncated]";
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) {
    return value.map((v) => sanitizeAuditValue(v, depth + 1));
  }
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
      if (REDACT_KEYS.has(normalizeKey(key))) {
        out[key] = "[redacted]";
      } else {
        out[key] = sanitizeAuditValue(raw, depth + 1);
      }
    }
    return out;
  }
  if (typeof value === "string" && value.length > 2_000) {
    return `${value.slice(0, 2_000)}…[truncated]`;
  }
  return value;
}

function firstResourceSegment(pathTemplate: string): string {
  const seg = pathTemplate.split("/").filter(Boolean)[0];
  return seg && seg !== ":id" ? seg : "admin";
}

function resolveResourceId(req: Request): string | null {
  const p = req.params as Record<string, string | undefined>;
  const raw = p.id ?? p.userId ?? p.payoutId ?? null;
  return typeof raw === "string" && raw.trim() ? raw.trim() : null;
}

/**
 * Logs every mutating admin request. Money-critical paths require a successful
 * audit write before the handler runs; all paths also record statusCode on finish.
 */
export function createAdminAuditMiddleware(prisma: PrismaClient) {
  return async function adminAuditMiddleware(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    const method = req.method.toUpperCase();
    if (!MUTATING_METHODS.has(method)) {
      next();
      return;
    }

    const adminId = req.admin?.id;
    if (!adminId) {
      next();
      return;
    }

    const pathTemplate = normalizeAdminPathTemplate(req.path || "/");
    const action = `${method} ${pathTemplate}`;
    const resource = firstResourceSegment(pathTemplate);
    const resourceId = resolveResourceId(req);
    const ip = getRequestIp(req) ?? null;
    const baseDetails = {
      params: sanitizeAuditValue(req.params),
      query: sanitizeAuditValue(req.query),
      body: sanitizeAuditValue(req.body),
    } as Prisma.InputJsonValue;

    const critical = isMoneyCriticalPath(req.path || "/");

    if (critical) {
      try {
        await logAdminActionOrThrow(
          prisma,
          adminId,
          action,
          resource,
          resourceId,
          {
            ...(baseDetails as Record<string, unknown>),
            phase: "before",
          } as Prisma.InputJsonValue,
          ip,
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(
          `[adminAudit] money-critical audit failed action=${action}: ${message}`,
        );
        res.status(500).json({
          error: "Audit log failed; money-critical action aborted",
        });
        return;
      }
    }

    res.on("finish", () => {
      void logAdminAction(
        prisma,
        adminId,
        action,
        resource,
        resourceId,
        {
          ...(baseDetails as Record<string, unknown>),
          phase: "after",
          statusCode: res.statusCode,
          moneyCritical: critical,
        } as Prisma.InputJsonValue,
        ip,
      );
    });

    next();
  };
}
