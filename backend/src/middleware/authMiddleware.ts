import type { NextFunction, Request, Response } from "express";
import jwt from "jsonwebtoken";
import type { PrismaClient } from "@prisma/client";
import { AdminRole, UserStatus } from "@prisma/client";
import { extractAccessToken } from "../utils/authToken.js";
import { isPlatformAdminUser } from "../utils/platformAdmin.js";

function tokenVersionFromPayload(decoded: object): number {
  const raw = (decoded as { tokenVersion?: unknown }).tokenVersion;
  if (typeof raw === "number" && Number.isFinite(raw)) return raw;
  return 0;
}

export type AccessTokenInspection =
  | { ok: true; userId: string }
  | { ok: false; status: number; error: string };

export async function inspectAccessToken(
  prisma: PrismaClient,
  token: string,
): Promise<AccessTokenInspection> {
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    return { ok: false, status: 500, error: "JWT_SECRET is not configured" };
  }

  try {
    const decoded = jwt.verify(token, secret);
    if (
      typeof decoded !== "object" ||
      decoded === null ||
      typeof (decoded as { sub?: unknown }).sub !== "string"
    ) {
      return { ok: false, status: 401, error: "Invalid token payload" };
    }

    const userId = (decoded as { sub: string }).sub;
    const claimedVersion = tokenVersionFromPayload(decoded);
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, status: true, tokenVersion: true },
    });

    if (!user) {
      return { ok: false, status: 401, error: "User not found" };
    }
    if (claimedVersion !== user.tokenVersion) {
      return { ok: false, status: 401, error: "Invalid or expired token" };
    }
    if (user.status !== UserStatus.ACTIVE) {
      return { ok: false, status: 403, error: "Account suspended" };
    }

    return { ok: true, userId };
  } catch {
    return { ok: false, status: 401, error: "Invalid or expired token" };
  }
}

/**
 * Requires a valid JWT from `Authorization: Bearer` or httpOnly `auth_token` cookie.
 * Loads the user from the DB and rejects suspended accounts.
 * Sets `req.userId` from the `sub` claim.
 */
export function authenticateJwt(prisma: PrismaClient): (
  req: Request,
  res: Response,
  next: NextFunction,
) => void {
  return async (req, res, next) => {
    const token = extractAccessToken(req);
    if (!token) {
      res.status(401).json({ error: "Missing or invalid Authorization header" });
      return;
    }

    const result = await inspectAccessToken(prisma, token);
    if (!result.ok) {
      res.status(result.status).json({ error: result.error });
      return;
    }

    req.userId = result.userId;
    next();
  };
}

/** Alias — same as {@link authenticateJwt}. */
export const authenticateToken = authenticateJwt;

/**
 * Must run after `authenticateJwt`. Requires platform admin access verified from DB
 * (`role === ADMIN` and `adminRole` set). Sets `req.admin` with RBAC role.
 */
export function requireAdmin(prisma: PrismaClient): (
  req: Request,
  res: Response,
  next: NextFunction,
) => void {
  return async (req, res, next) => {
    const userId = req.userId;
    if (!userId) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }

    try {
      const user = await prisma.user.findUnique({
        where: { id: userId },
        select: {
          id: true,
          role: true,
          adminRole: true,
          email: true,
          name: true,
        },
      });

      if (!user || !isPlatformAdminUser(user)) {
        res.status(403).json({ error: "Admin access required" });
        return;
      }

      const secret = process.env.JWT_SECRET;
      if (secret) {
        const token = extractAccessToken(req);
        if (token) {
          try {
            const decoded = jwt.verify(token, secret);
            if (
              typeof decoded === "object" &&
              decoded !== null &&
              "role" in decoded &&
              typeof (decoded as { role?: unknown }).role === "string" &&
              (decoded as { role: string }).role !== user.role
            ) {
              res.status(403).json({ error: "Admin access required" });
              return;
            }
          } catch {
            res.status(401).json({ error: "Invalid or expired token" });
            return;
          }
        }
      }

      req.admin = {
        id: user.id,
        role: user.adminRole ?? AdminRole.SUPPORT,
        email: user.email,
        name: user.name,
      };
      next();
    } catch (err) {
      next(err);
    }
  };
}

/** Alias — same as {@link requireAdmin}. */
export function isAdmin(prisma: PrismaClient) {
  return requireAdmin(prisma);
}

/**
 * Restrict route to specific {@link AdminRole} values. Must run after `requireAdmin`.
 */
export function authorizeRoles(...allowedRoles: AdminRole[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const admin = req.admin;
    if (!admin) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    if (!allowedRoles.includes(admin.role)) {
      res.status(403).json({ error: "Insufficient admin permissions" });
      return;
    }
    next();
  };
}
