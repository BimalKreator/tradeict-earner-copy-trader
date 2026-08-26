import type { NextFunction, Request, Response } from "express";
import { SubscriptionStatus, type PrismaClient } from "@prisma/client";
import { initializeDeltaClient } from "../services/exchangeService.js";
import {
  decryptDeltaSecretOrPlain,
  normalizeStoredDeltaSecret,
} from "../utils/encryption.js";
import {
  ensureBotSlaveForSubscription,
  validateDeltaKeysForTrading,
} from "../services/botBridgeService.js";

const listSelect = {
  id: true,
  nickname: true,
  exchange: true,
  createdAt: true,
} as const;

export type ConnectExchangeAccountInput = {
  nickname: string;
  apiKey: string;
  apiSecret: string;
  exchange?: string;
};

export type ConnectExchangeAccountResult =
  | { ok: true; status: 201; account: { id: string; nickname: string; exchange: string; createdAt: Date } }
  | { ok: false; status: number; error: string; reason?: string };

export type DisconnectExchangeAccountResult =
  | { ok: true; status: 204 }
  | { ok: false; status: number; error: string; body?: Record<string, unknown> };

/**
 * Validate keys (auth + trading), create ExchangeAccount, and auto-register
 * bot slaves with botSlaveId + exchangeAccountId always persisted.
 */
export async function connectExchangeAccountForUser(
  prisma: PrismaClient,
  userId: string,
  input: ConnectExchangeAccountInput,
): Promise<ConnectExchangeAccountResult> {
  const nickname = input.nickname.trim();
  const apiKey = input.apiKey.trim();
  const apiSecret = input.apiSecret.trim();
  const exchange = (input.exchange?.trim() || "Delta").trim() || "Delta";

  if (!nickname) {
    return { ok: false, status: 400, error: "nickname is required" };
  }
  if (!apiKey || !apiSecret) {
    return { ok: false, status: 400, error: "apiKey and apiSecret are required" };
  }

  const validation = await validateDeltaKeysForTrading(apiKey, apiSecret);
  if (!validation.ok) {
    return {
      ok: false,
      status: validation.status,
      error: validation.error,
      reason: validation.reason,
    };
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

        if (botSlaveId == null) {
          await prisma.exchangeAccount.delete({ where: { id: account.id } });
          return {
            ok: false,
            status: 400,
            error:
              "Delta bot rejected these API keys — account was not connected.",
            reason: "unknown",
          };
        }

        await prisma.userStrategySubscription.update({
          where: { id: sub.id },
          data: {
            botSlaveId: String(botSlaveId),
            exchangeAccountId: account.id,
            isActive: true,
            status: SubscriptionStatus.ACTIVE,
          },
        });
        console.log(
          "[ExchangeAccount] Auto-registered bot slave:",
          botSlaveId,
          "for sub:",
          sub.id,
        );
      }
    }
  } catch (autoRegErr) {
    await prisma.exchangeAccount.delete({ where: { id: account.id } }).catch(() => {
      /* best-effort rollback */
    });
    const msg =
      autoRegErr instanceof Error ? autoRegErr.message : String(autoRegErr);
    console.error("[ExchangeAccount] Auto bot registration error:", msg);
    return {
      ok: false,
      status: 502,
      error: "Failed to register trading keys with the bot — account was not connected.",
    };
  }

  return { ok: true, status: 201, account };
}

/**
 * Disconnect: deactivate every bot slave keyed by botSlaveId first.
 * Refuse delete if any deactivation fails (stuck row beats live keys on bot).
 */
export async function disconnectExchangeAccountForUser(
  prisma: PrismaClient,
  userId: string,
  accountId: string,
): Promise<DisconnectExchangeAccountResult> {
  const id = accountId.trim();
  if (!id) {
    return { ok: false, status: 400, error: "id is required" };
  }

  const existing = await prisma.exchangeAccount.findFirst({
    where: { id, userId },
  });

  if (!existing) {
    return { ok: false, status: 404, error: "Exchange account not found" };
  }

  // Key off botSlaveId. Auto-register historically omitted exchangeAccountId —
  // those rows still hold live bot keys and must be deactivated on disconnect.
  const botSubs = await prisma.userStrategySubscription.findMany({
    where: {
      userId,
      status: {
        in: [SubscriptionStatus.ACTIVE, SubscriptionStatus.PAUSED_DUE_TO_FUNDS],
      },
      strategy: {
        AND: [
          { botStrategyType: { not: null } },
          { NOT: { botStrategyType: "" } },
        ],
      },
      OR: [
        { exchangeAccountId: existing.id },
        {
          AND: [{ exchangeAccountId: null }, { botSlaveId: { not: null } }],
        },
      ],
    },
    select: {
      id: true,
      userId: true,
      strategyId: true,
      botSlaveId: true,
      strategy: { select: { botStrategyType: true } },
    },
  });

  const missingSlaveId = botSubs.filter(
    (s) => !(typeof s.botSlaveId === "string" && s.botSlaveId.trim().length > 0),
  );
  if (missingSlaveId.length > 0) {
    return {
      ok: false,
      status: 502,
      error:
        "Cannot disconnect: bot-strategy subscription is missing botSlaveId — refuse delete while the bot may still hold keys.",
    };
  }

  const {
    closeAndBillForBotSubscription,
    mapCancellationBillingError,
  } = await import("../services/cancellationBillingService.js");

  for (const sub of botSubs) {
    try {
      await closeAndBillForBotSubscription(prisma, sub, "API_DISCONNECTED");
    } catch (billingErr) {
      const mapped = mapCancellationBillingError(billingErr);
      if (mapped) {
        return {
          ok: false,
          status: mapped.status,
          error: String(mapped.body.error ?? "Bot deactivation failed"),
          body: mapped.body,
        };
      }
      const msg =
        billingErr instanceof Error ? billingErr.message : String(billingErr);
      return {
        ok: false,
        status: 502,
        error: `Bot slave could not be deactivated — disconnect refused. ${msg}`,
      };
    }
  }

  await prisma.exchangeAccount.delete({
    where: { id: existing.id },
  });

  return { ok: true, status: 204 };
}

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

      const result = await connectExchangeAccountForUser(prisma, userId, {
        nickname: typeof body.nickname === "string" ? body.nickname : "",
        apiKey: typeof body.apiKey === "string" ? body.apiKey : "",
        apiSecret: typeof body.apiSecret === "string" ? body.apiSecret : "",
        ...(typeof body.exchange === "string" ? { exchange: body.exchange } : {}),
      });

      if (!result.ok) {
        res.status(result.status).json({
          error: result.error,
          ...(result.reason ? { reason: result.reason } : {}),
        });
        return;
      }

      res.status(201).json(result.account);
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

      const result = await disconnectExchangeAccountForUser(prisma, userId, id);
      if (!result.ok) {
        res.status(result.status).json(result.body ?? { error: result.error });
        return;
      }

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
