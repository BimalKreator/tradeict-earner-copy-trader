import type { NextFunction, Request, Response } from "express";
import { Prisma, type PrismaClient, TransactionStatus } from "@prisma/client";

export function createWalletController(prisma: PrismaClient) {
  async function topUp(
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

      const body = req.body as {
        amount?: unknown;
        utrNumber?: unknown;
      };

      const amount =
        typeof body.amount === "number"
          ? body.amount
          : typeof body.amount === "string"
            ? Number(body.amount)
            : NaN;

      const utrNumber =
        typeof body.utrNumber === "string" ? body.utrNumber.trim() : "";

      if (!Number.isFinite(amount) || amount <= 0) {
        res.status(400).json({ error: "amount must be a positive number" });
        return;
      }

      if (!utrNumber) {
        res.status(400).json({ error: "utrNumber is required" });
        return;
      }

      const tx = await prisma.transaction.create({
        data: {
          userId,
          amount,
          utrNumber,
          status: TransactionStatus.PENDING,
        },
      });

      res.status(201).json(tx);
    } catch (err) {
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === "P2002"
      ) {
        res.status(409).json({ error: "This UTR number is already registered" });
        return;
      }
      next(err);
    }
  }

  async function listTransactions(
    _req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      const items = await prisma.transaction.findMany({
        orderBy: { createdAt: "desc" },
        include: {
          user: {
            select: {
              id: true,
              email: true,
            },
          },
        },
      });
      res.json(items);
    } catch (err) {
      next(err);
    }
  }

  async function approve(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      const body = req.body as {
        transactionId?: unknown;
        action?: unknown;
      };

      const transactionId =
        typeof body.transactionId === "string"
          ? body.transactionId.trim()
          : "";

      const actionRaw =
        typeof body.action === "string" ? body.action.trim().toUpperCase() : "";

      if (!transactionId) {
        res.status(400).json({ error: "transactionId is required" });
        return;
      }

      if (actionRaw !== "APPROVED" && actionRaw !== "REJECTED") {
        res
          .status(400)
          .json({ error: "action must be APPROVED or REJECTED" });
        return;
      }

      const outcome = await prisma.$transaction(async (tx) => {
        const row = await tx.transaction.findUnique({
          where: { id: transactionId },
        });

        if (!row) {
          return {
            ok: false as const,
            status: 404,
            message: "Transaction not found",
          };
        }

        if (row.status !== TransactionStatus.PENDING) {
          return {
            ok: false as const,
            status: 400,
            message: "Transaction is not pending",
          };
        }

        if (actionRaw === "REJECTED") {
          await tx.transaction.update({
            where: { id: row.id },
            data: { status: TransactionStatus.REJECTED },
          });
          return { ok: true as const };
        }

        await tx.transaction.update({
          where: { id: row.id },
          data: { status: TransactionStatus.APPROVED },
        });

        await tx.wallet.upsert({
          where: { userId: row.userId },
          create: {
            userId: row.userId,
            balance: row.amount,
            pendingFees: 0,
            overdueDays: 0,
          },
          update: {
            balance: { increment: row.amount },
          },
        });

        return { ok: true as const };
      });

      if (!outcome.ok) {
        res.status(outcome.status).json({ error: outcome.message });
        return;
      }

      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  }

  return {
    topUp,
    listTransactions,
    approve,
  };
}
