import type { NextFunction, Request, Response } from "express";
import type { PrismaClient } from "@prisma/client";
import {
  broadcastNotifications,
  parseBroadcastAudience,
} from "../services/notificationBroadcastService.js";

export function createAdminNotificationController(prisma: PrismaClient) {
  async function broadcast(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      const body = req.body as {
        audience?: unknown;
        userIds?: unknown;
        title?: unknown;
        message?: unknown;
      };

      const title = typeof body.title === "string" ? body.title.trim() : "";
      const message =
        typeof body.message === "string" ? body.message.trim() : "";

      if (!title) {
        res.status(400).json({ error: "title is required" });
        return;
      }
      if (!message) {
        res.status(400).json({ error: "message is required" });
        return;
      }
      if (title.length > 200) {
        res.status(400).json({ error: "title must be at most 200 characters" });
        return;
      }
      if (message.length > 5000) {
        res.status(400).json({
          error: "message must be at most 5000 characters",
        });
        return;
      }

      const audience = parseBroadcastAudience(body);
      if (!audience) {
        res.status(400).json({
          error:
            'audience must be "ALL", "ACTIVE", an array of userIds, or "SPECIFIC" with userIds',
        });
        return;
      }

      const result = await broadcastNotifications(prisma, {
        title,
        message,
        audience,
      });

      console.log(
        `[broadcast] admin notification sent title="${title}" recipients=${result.recipientCount} inApp=${result.notificationsCreated} emailOk=${result.emailsSent} emailFail=${result.emailsFailed}`,
      );

      res.status(201).json({
        ok: true,
        ...result,
      });
    } catch (err) {
      next(err);
    }
  }

  return { broadcast };
}
