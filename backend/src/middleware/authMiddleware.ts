import type { NextFunction, Request, Response } from "express";
import jwt from "jsonwebtoken";
import type { PrismaClient } from "@prisma/client";
import { Role } from "@prisma/client";

/**
 * Requires `Authorization: Bearer <jwt>` with valid JWT_SECRET signature.
 * Sets `req.userId` from the `sub` claim.
 */
export function authenticateJwt(): (
  req: Request,
  res: Response,
  next: NextFunction,
) => void {
  return (req, res, next) => {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith("Bearer ")) {
      res.status(401).json({ error: "Missing or invalid Authorization header" });
      return;
    }

    const token = authHeader.slice("Bearer ".length).trim();
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
      req.userId = (decoded as { sub: string }).sub;
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
        select: { role: true },
      });

      if (!user || user.role !== Role.ADMIN) {
        res.status(403).json({ error: "Admin access required" });
        return;
      }

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
