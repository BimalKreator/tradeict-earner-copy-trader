import type { NextFunction, Request, Response } from "express";
import type { PrismaClient } from "@prisma/client";

export function createUserController(prisma: PrismaClient) {
  async function getMe(
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
        select: {
          id: true,
          email: true,
          name: true,
          mobile: true,
        },
      });

      if (!user) {
        res.status(404).json({ error: "User not found" });
        return;
      }

      res.json(user);
    } catch (err) {
      next(err);
    }
  }

  async function patchMe(
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

      const body = req.body as { name?: unknown; mobile?: unknown };
      const data: { name?: string | null; mobile?: string | null } = {};

      if ("name" in body) {
        if (body.name === null || body.name === undefined) {
          data.name = null;
        } else if (typeof body.name === "string") {
          const n = body.name.trim();
          data.name = n.length ? n : null;
        } else {
          res.status(400).json({ error: "name must be a string or null" });
          return;
        }
      }

      if ("mobile" in body) {
        if (body.mobile === null || body.mobile === undefined) {
          data.mobile = null;
        } else if (typeof body.mobile === "string") {
          const m = body.mobile.trim();
          data.mobile = m.length ? m : null;
        } else {
          res.status(400).json({ error: "mobile must be a string or null" });
          return;
        }
      }

      if (Object.keys(data).length === 0) {
        res.status(400).json({ error: "Provide name and/or mobile to update" });
        return;
      }

      const user = await prisma.user.update({
        where: { id: userId },
        data,
        select: {
          id: true,
          email: true,
          name: true,
          mobile: true,
        },
      });

      res.json(user);
    } catch (err) {
      next(err);
    }
  }

  return { getMe, patchMe };
}
