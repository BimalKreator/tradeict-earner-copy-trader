import type { NextFunction, Request, Response } from "express";
import type { PrismaClient } from "@prisma/client";

export function createDepositController(prisma: PrismaClient) {
  async function createDeposit(
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
      const amount = Number((req.body as { amount?: unknown }).amount);
      const transactionId = String(
        (req.body as { transactionId?: unknown }).transactionId ?? "",
      ).trim();
      if (!Number.isFinite(amount) || amount <= 0) {
        res.status(400).json({ error: "Amount must be a positive number." });
        return;
      }
      if (!transactionId) {
        res.status(400).json({ error: "transactionId is required." });
        return;
      }

      const screenshotUrl = req.file
        ? `/uploads/${req.file.filename}`
        : null;

      const row = await prisma.depositRequest.create({
        data: {
          userId,
          amount,
          transactionId,
          screenshotUrl,
        },
      });

      await prisma.notification.create({
        data: {
          userId: null,
          title: "New Deposit Request",
          message: `A new deposit request was submitted. User: ${userId}, Amount: ${amount.toFixed(
            2,
          )}, Transaction ID: ${transactionId}.`,
        },
      });

      res.status(201).json({
        id: row.id,
        amount: row.amount,
        transactionId: row.transactionId,
        screenshotUrl: row.screenshotUrl,
        status: row.status,
        createdAt: row.createdAt,
      });
    } catch (err) {
      next(err);
    }
  }

  async function listMyDeposits(
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
      const rows = await prisma.depositRequest.findMany({
        where: { userId },
        orderBy: { createdAt: "desc" },
      });
      res.json({ deposits: rows });
    } catch (err) {
      next(err);
    }
  }

  async function listAllDeposits(
    _req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      const rows = await prisma.depositRequest.findMany({
        orderBy: { createdAt: "desc" },
        include: {
          user: { select: { id: true, email: true, name: true } },
        },
      });
      res.json({
        deposits: rows.map((r) => ({
          id: r.id,
          userId: r.userId,
          userEmail: r.user.email,
          userName: r.user.name,
          amount: r.amount,
          transactionId: r.transactionId,
          screenshotUrl: r.screenshotUrl,
          status: r.status,
          adminReason: r.adminReason,
          createdAt: r.createdAt,
          updatedAt: r.updatedAt,
        })),
      });
    } catch (err) {
      next(err);
    }
  }

  async function updateDepositStatus(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      const id = String(req.params.id ?? "").trim();
      const status = String((req.body as { status?: unknown }).status ?? "")
        .trim()
        .toUpperCase();
      const adminReasonRaw = (req.body as { adminReason?: unknown }).adminReason;
      const adminReason =
        typeof adminReasonRaw === "string" && adminReasonRaw.trim() !== ""
          ? adminReasonRaw.trim()
          : null;

      if (!id) {
        res.status(400).json({ error: "Deposit request id is required." });
        return;
      }
      if (status !== "APPROVED" && status !== "REJECTED") {
        res
          .status(400)
          .json({ error: "status must be either APPROVED or REJECTED." });
        return;
      }

      const updated = await prisma.depositRequest.update({
        where: { id },
        data: { status, adminReason },
      });

      await prisma.notification.create({
        data: {
          userId: updated.userId,
          title: "Deposit Request Update",
          message:
            status === "APPROVED"
              ? "Your deposit request has been approved."
              : `Your deposit request has been rejected.${
                  adminReason ? ` Reason: ${adminReason}` : ""
                }`,
        },
      });

      res.json({ ok: true, deposit: updated });
    } catch (err) {
      next(err);
    }
  }

  return { createDeposit, listMyDeposits, listAllDeposits, updateDepositStatus };
}

