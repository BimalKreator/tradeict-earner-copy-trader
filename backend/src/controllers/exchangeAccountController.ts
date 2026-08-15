import type { NextFunction, Request, Response } from "express";
import type { PrismaClient } from "@prisma/client";
import { initializeDeltaClient } from "../services/exchangeService.js";
import {
  decryptDeltaSecretOrPlain,
  normalizeStoredDeltaSecret,
} from "../utils/encryption.js";

const listSelect = {
  id: true,
  nickname: true,
  exchange: true,
  createdAt: true,
} as const;

export function createExchangeAccountController(prisma: PrismaClient) {
  async function list(
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

      const accounts = await prisma.exchangeAccount.findMany({
        where: { userId },
        select: listSelect,
        orderBy: { createdAt: "desc" },
      });

      res.json({ accounts });
    } catch (err) {
      next(err);
    }
  }

  async function create(
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
        nickname?: unknown;
        apiKey?: unknown;
        apiSecret?: unknown;
        exchange?: unknown;
      };

      const nickname =
        typeof body.nickname === "string" ? body.nickname.trim() : "";
      const apiKey = typeof body.apiKey === "string" ? body.apiKey.trim() : "";
      const apiSecret =
        typeof body.apiSecret === "string" ? body.apiSecret.trim() : "";
      const exchangeRaw =
        typeof body.exchange === "string" ? body.exchange.trim() : "";
      const exchange = exchangeRaw.length ? exchangeRaw : "Delta";

      if (!nickname) {
        res.status(400).json({ error: "nickname is required" });
        return;
      }
      if (!apiKey || !apiSecret) {
        res.status(400).json({ error: "apiKey and apiSecret are required" });
        return;
      }

      const account = await prisma.exchangeAccount.create({
        data: {
          userId,
          nickname,
          exchange,
          apiKey: normalizeStoredDeltaSecret(apiKey),
          apiSecret: normalizeStoredDeltaSecret(apiSecret),
        },
        select: listSelect,
      });

      // Auto-register bot slaves for existing bot-type strategy subscriptions
      try {
        const botSubs = await prisma.userStrategySubscription.findMany({
          where: {
            userId,
            strategy: {
              botStrategyType: { not: null },
              botUrl: { not: null },
            },
          },
          include: {
            strategy: {
              select: {
                id: true,
                botStrategyType: true,
                botUrl: true,
                baseCapital: true,
                minCapital: true,
              },
            },
          },
        });

        if (botSubs.length > 0) {
          const {
            ensureBotSlaveForSubscription,
          } = await import("../services/botBridgeService.js");

          for (const sub of botSubs) {
            const deployedCapital =
              (typeof sub.multiplier === "number" && Number.isFinite(sub.multiplier)
                ? sub.multiplier
                : 1) * (sub.strategy.baseCapital ?? 300);

            const botSlaveId = await ensureBotSlaveForSubscription({
              userId,
              strategyId: sub.strategyId,
              subscriptionId: sub.id,
              apiKey,
              apiSecret,
              userAllocatedCapitalUsd: deployedCapital,
            });

            if (botSlaveId != null) {
              await prisma.$executeRaw`
                UPDATE "UserSubscription"
                SET "botSlaveId" = ${String(botSlaveId)}, "isActive" = true
                WHERE id = ${sub.id}
              `;
              console.log(
                "[ExchangeAccount] Auto-registered bot slave:",
                botSlaveId,
                "for sub:",
                sub.id,
              );
            }
          }
        }
      } catch (autoRegErr) {
        // Non-fatal — account already saved
        console.error(
          "[ExchangeAccount] Auto bot registration error:",
          autoRegErr,
        );
      }

      res.status(201).json(account);
    } catch (err) {
      next(err);
    }
  }

  async function remove(
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

      const rawId = req.params.id;
      const id = Array.isArray(rawId) ? rawId[0] : rawId;
      if (typeof id !== "string" || !id.trim()) {
        res.status(400).json({ error: "id is required" });
        return;
      }

      const existing = await prisma.exchangeAccount.findFirst({
        where: { id: id.trim(), userId },
      });

      if (!existing) {
        res.status(404).json({ error: "Exchange account not found" });
        return;
      }

      await prisma.exchangeAccount.delete({
        where: { id: existing.id },
      });

      res.status(204).send();
    } catch (err) {
      next(err);
    }
  }

  async function testConnection(
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

      const body = req.body as { exchangeAccountId?: unknown };
      const exchangeAccountId =
        typeof body.exchangeAccountId === "string"
          ? body.exchangeAccountId.trim()
          : "";

      if (!exchangeAccountId) {
        res.status(400).json({ error: "exchangeAccountId is required" });
        return;
      }

      const account = await prisma.exchangeAccount.findFirst({
        where: { id: exchangeAccountId, userId },
      });

      if (!account) {
        res.status(404).json({ error: "Exchange account not found" });
        return;
      }

      try {
        const apiKey = decryptDeltaSecretOrPlain(account.apiKey);
        const secret = decryptDeltaSecretOrPlain(account.apiSecret);
        if (!apiKey || !secret) {
          res.json({
            success: false,
            error: "Could not decrypt stored API credentials",
          });
          return;
        }
        const exchange = initializeDeltaClient(apiKey, secret);
        await exchange.loadMarkets();
        await exchange.fetchBalance();
        res.json({ success: true });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        res.json({ success: false, error: message });
      }
    } catch (err) {
      next(err);
    }
  }

  return { list, create, remove, testConnection };
}
