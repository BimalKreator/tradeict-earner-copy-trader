import type { Request } from "express";
import { Prisma, type PrismaClient } from "@prisma/client";

export function getRequestIp(req: Request): string | undefined {
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string" && forwarded.trim()) {
    return forwarded.split(",")[0]?.trim() || undefined;
  }
  if (Array.isArray(forwarded) && forwarded[0]) {
    return forwarded[0].trim();
  }
  const remote = req.socket?.remoteAddress;
  return remote ?? undefined;
}

/**
 * Persist an admin audit log entry. Failures are logged and never thrown to callers.
 */
export async function logAdminAction(
  prisma: PrismaClient,
  adminId: string,
  action: string,
  resource: string,
  resourceId: string | null | undefined,
  details: Prisma.InputJsonValue | null | undefined,
  ip?: string | null,
): Promise<void> {
  try {
    await prisma.adminAuditLog.create({
      data: {
        adminId,
        action,
        resource,
        resourceId: resourceId ?? null,
        details: details ?? Prisma.JsonNull,
        ipAddress: ip ?? null,
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(
      `[auditLogger] Failed action=${action} resource=${resource} adminId=${adminId}: ${message}`,
    );
  }
}

/** Fire-and-forget audit helper for controllers. */
export function logAdminActionAsync(
  prisma: PrismaClient,
  adminId: string,
  action: string,
  resource: string,
  resourceId: string | null | undefined,
  details: Prisma.InputJsonValue | null | undefined,
  ip?: string | null,
): void {
  void logAdminAction(
    prisma,
    adminId,
    action,
    resource,
    resourceId,
    details,
    ip,
  );
}

export function auditFromRequest(
  prisma: PrismaClient,
  req: Request,
  action: string,
  resource: string,
  resourceId: string | null | undefined,
  details: Prisma.InputJsonValue | null | undefined,
): void {
  const adminId = req.admin?.id ?? req.userId;
  if (!adminId) return;
  logAdminActionAsync(
    prisma,
    adminId,
    action,
    resource,
    resourceId,
    details,
    getRequestIp(req),
  );
}
