import type { PrismaClient } from "@prisma/client";
import {
  ATTRIBUTION_STATUS,
  BILLING_TXN_TYPES,
  ledgerTxnMatchesLegWindow,
  resolveLegAttributionWindowStart,
} from "./structurePnlService.js";

export type AttributionHealthLeg = {
  botLegId: number;
  legRole: string;
  productId: number;
  symbol: string | null;
  matchedTxnCount: number;
  openedAt: string;
  closedAt: string | null;
  firstMatchedTxnAt: string | null;
  lastMatchedTxnAt: string | null;
  matchedCashflowSigns: { positive: boolean; negative: boolean };
};

export type AttributionHealthStructure = {
  id: string;
  botStructureId: number;
  status: string;
  realizedPnl: number | null;
  attributionStatus: string | null;
  attributionNote: string | null;
  openedAt: string;
  closedAt: string | null;
  legs: AttributionHealthLeg[];
};

export async function getAttributionHealthForUser(
  prisma: PrismaClient,
  userId: string,
): Promise<{ userId: string; structures: AttributionHealthStructure[] }> {
  const [structures, ledgerRows] = await Promise.all([
    prisma.structurePnl.findMany({
      where: {
        userId,
        attributionStatus: ATTRIBUTION_STATUS.SUSPECT_INCOMPLETE,
      },
      orderBy: { closedAt: "desc" },
      include: {
        legs: { orderBy: { botLegId: "asc" } },
      },
    }),
    prisma.deltaLedgerEntry.findMany({
      where: {
        userId,
        transactionType: { in: [...BILLING_TXN_TYPES] },
      },
      orderBy: { occurredAt: "asc" },
      select: {
        productId: true,
        transactionType: true,
        amount: true,
        occurredAt: true,
      },
    }),
  ]);

  return {
    userId,
    structures: structures.map((structure) => ({
      id: structure.id,
      botStructureId: structure.botStructureId,
      status: structure.status,
      realizedPnl: structure.realizedPnl?.toNumber() ?? null,
      attributionStatus: structure.attributionStatus,
      attributionNote: structure.attributionNote,
      openedAt: structure.openedAt.toISOString(),
      closedAt: structure.closedAt?.toISOString() ?? null,
      legs: structure.legs.map((leg) => {
        const matched = ledgerRows.filter((txn) =>
          ledgerTxnMatchesLegWindow(txn, {
            productId: leg.productId,
            attributionFrom: resolveLegAttributionWindowStart(leg),
            closedAt: leg.closedAt,
          }),
        );

        let cashflowPositive = false;
        let cashflowNegative = false;
        for (const txn of matched) {
          if (txn.transactionType.toLowerCase() !== "cashflow") continue;
          if (txn.amount.greaterThan(0)) cashflowPositive = true;
          if (txn.amount.lessThan(0)) cashflowNegative = true;
        }

        return {
          botLegId: leg.botLegId,
          legRole: leg.legRole,
          productId: leg.productId,
          symbol: leg.symbol,
          matchedTxnCount: leg.matchedTxnCount,
          openedAt: leg.openedAt.toISOString(),
          closedAt: leg.closedAt?.toISOString() ?? null,
          firstMatchedTxnAt: matched[0]?.occurredAt.toISOString() ?? null,
          lastMatchedTxnAt:
            matched.length > 0
              ? matched[matched.length - 1]!.occurredAt.toISOString()
              : null,
          matchedCashflowSigns: {
            positive: cashflowPositive,
            negative: cashflowNegative,
          },
        };
      }),
    })),
  };
}
