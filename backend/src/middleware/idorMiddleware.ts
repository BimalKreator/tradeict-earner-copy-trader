import type { NextFunction, Request, Response } from "express";
import type { PrismaClient } from "@prisma/client";
import { isPlatformAdminUser } from "../utils/platformAdmin.js";

type IdParam = "id" | "userId";

/**
 * Ensures the authenticated user may only access their own `:id` / `:userId` resource.
 * Platform admins (`role === ADMIN` or `adminRole` set) may access any user id.
 */
export function requireSelfOrAdmin(
  prisma: PrismaClient,
  paramName: IdParam = "id",
): (req: Request, res: Response, next: NextFunction) => void {
  return async (req, res, next) => {
    const authUserId = req.userId;
    if (!authUserId) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }

    const raw = req.params[paramName];
    const targetId = (Array.isArray(raw) ? raw[0] : raw)?.trim() ?? "";
    if (!targetId) {
      res.status(400).json({ error: `${paramName} is required` });
      return;
    }

    if (targetId === authUserId) {
      next();
      return;
    }

    try {
      const actor = await prisma.user.findUnique({
        where: { id: authUserId },
        select: { role: true, adminRole: true },
      });
      if (actor && isPlatformAdminUser(actor)) {
        next();
        return;
      }
      res.status(403).json({ error: "Forbidden" });
    } catch (err) {
      next(err);
    }
  };
}
