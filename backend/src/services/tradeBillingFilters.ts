import type { Prisma } from "@prisma/client";

/** Marks Trade rows written by the retired botSyncService MTM poller. */
export const TRADE_SOURCE_BOT_SYNC_LEGACY = "BOT_SYNC_LEGACY";

export const BOT_SYNC_EXIT_REASON = "BOT_SYNC_CLOSE";

/** When false (default), botSyncService must not mutate Trade billing fields. */
export function isBotSyncWritesEnabled(): boolean {
  return process.env.BOT_SYNC_WRITES_ENABLED === "true";
}

export function isBotStrategyType(
  botStrategyType: string | null | undefined,
): boolean {
  return (
    typeof botStrategyType === "string" && botStrategyType.trim().length > 0
  );
}

/** Exclude stale bot-sync MTM trades from all billing aggregations. */
export function excludeLegacyBotSyncTradesWhere(): Prisma.TradeWhereInput {
  return {
    NOT: {
      OR: [
        { source: TRADE_SOURCE_BOT_SYNC_LEGACY },
        {
          exitReason: BOT_SYNC_EXIT_REASON,
          strategy: {
            AND: [
              { botStrategyType: { not: null } },
              { NOT: { botStrategyType: "" } },
            ],
          },
        },
      ],
    },
  };
}

/** Strategies billed via MonthlyRevenueInvoice (Delta pipeline), not Trade rows. */
export function nonBotStrategyWhere(): Prisma.StrategyWhereInput {
  return {
    OR: [{ botStrategyType: null }, { botStrategyType: "" }],
  };
}

export function botStrategyWhere(): Prisma.StrategyWhereInput {
  return {
    AND: [
      { botStrategyType: { not: null } },
      { NOT: { botStrategyType: "" } },
    ],
  };
}
