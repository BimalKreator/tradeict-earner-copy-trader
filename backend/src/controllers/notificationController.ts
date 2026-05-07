import type { NextFunction, Request, Response } from "express";
import { Role, type PrismaClient } from "@prisma/client";

export function createNotificationController(prisma: PrismaClient) {
  async function listNotifications(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      const userId = req.userId;
      if (!userId) {
        res.status(401).json({ error: "Unauthorized" });
        return;
      }
      const user = await prisma.user.findUnique({
        where: { id: userId },
        select: { role: true },
      });
      if (!user) {
        res.status(404).json({ error: "User not found." });
        return;
      }
      const where = user.role === Role.ADMIN ? { userId: null } : { userId };
      const rows = await prisma.notification.findMany({
        where,
        orderBy: { createdAt: "desc" },
      });
      res.json({ notifications: rows });
    } catch (err) {
      next(err);
    }
  }

  async function markNotificationRead(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      const userId = req.userId;
      if (!userId) {
        res.status(401).json({ error: "Unauthorized" });
        return;
      }
      const id = String(req.params.id ?? "").trim();
      if (!id) {
        res.status(400).json({ error: "Notification id is required." });
        return;
      }

      const user = await prisma.user.findUnique({
        where: { id: userId },
        select: { role: true },
      });
      if (!user) {
        res.status(404).json({ error: "User not found." });
        return;
      }

      const updated = await prisma.notification.updateMany({
        where:
          user.role === Role.ADMIN
            ? { id, userId: null }
            : { id, userId },
        data: { isRead: true },
      });
      if (updated.count === 0) {
        res.status(404).json({ error: "Notification not found." });
        return;
      }
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  }

  return { listNotifications, markNotificationRead };
}

