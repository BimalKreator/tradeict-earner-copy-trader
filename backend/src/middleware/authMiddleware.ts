import type { NextFunction, Request, Response } from "express";
import jwt from "jsonwebtoken";
import type { PrismaClient } from "@prisma/client";
import { AdminRole, Role, UserStatus } from "@prisma/client";
import { AUTH_COOKIE_NAME } from "../utils/authToken.js";
import { isPlatformAdminUser } from "../utils/platformAdmin.js";

function extractBearerToken(req: Request): string | null {
  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith("Bearer ")) {
    const t = authHeader.slice("Bearer ".length).trim();
    if (t) return t;
  }
  const cookies = req.cookies as Record<string, string | undefined> | undefined;
  const fromCookie = cookies?.[AUTH_COOKIE_NAME];
  if (typeof fromCookie === "string" && fromCookie.trim()) {
    return fromCookie.trim();
  }
  return null;
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
    const token = extractBearerToken(req);
    if (!token) {
      res.status(401).json({ error: "Missing or invalid Authorization header" });
      return;
    }
    const secret = process.env.JWT_SECRET;
    if (!secret) {
      res.status(500).json({ error: "JWT_SECRET is not configured" });
      return;
    }

    try {
      const decoded = jwt.verify(token, secret);
      if (
        typeof decoded !== "object" ||
        decoded === null ||
        typeof (decoded as { sub?: unknown }).sub !== "string"
      ) {
        res.status(401).json({ error: "Invalid token payload" });
        return;
      }

      const userId = (decoded as { sub: string }).sub;
      const user = await prisma.user.findUnique({
        where: { id: userId },
        select: { id: true, status: true },
      });

      if (!user) {
        res.status(401).json({ error: "User not found" });
        return;
      }
      if (user.status !== UserStatus.ACTIVE) {
        res.status(403).json({ error: "Account suspended" });
        return;
      }

      req.userId = userId;
      next();
    } catch {
      res.status(401).json({ error: "Invalid or expired token" });
    }
  };
}

/** Alias — same as {@link authenticateJwt}. */
export const authenticateToken = authenticateJwt;

/**
 * Must run after `authenticateJwt`. Loads user and requires `role === ADMIN`.
 * Sets `req.admin` with id, RBAC role, email, and name.
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

      req.admin = {
        id: user.id,
        role: user.adminRole ?? AdminRole.SUPER_ADMIN,
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
