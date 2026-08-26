/**
 * Read-only measurement for 15.4: count currently-OK structures that would
 * become SUSPECT if we mark both legs when a txn sits in leg A's chronological
 * grace AND leg B's real (non-grace) window — the silent-award-to-B case.
 *
 *   npx tsx src/scripts/measureGraceAmbiguity.ts
 */
import "dotenv/config";
import pg from "pg";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";
import {
  ATTRIBUTION_STATUS,
  BILLING_TXN_TYPES,
  LEG_CLOSE_GRACE_MS,
  resolveLegAttributionWindowStart,
  type LegWindowSpec,
} from "../services/structurePnlService.js";

function createPrisma(): PrismaClient {
  const connectionString = process.env.DATABASE_URL?.trim();
  if (!connectionString) throw new Error("DATABASE_URL required");
  const pool = new pg.Pool({ connectionString });
  return new PrismaClient({ adapter: new PrismaPg(pool) });
}

/** Real open window (no grace): opened..closedAt, or open if closedAt null. */
function inRealWindow(leg: LegWindowSpec, at: Date): boolean {
  if (at < resolveLegAttributionWindowStart(leg)) return false;
  if (!leg.closedAt) return true;
  return at.getTime() <= leg.closedAt.getTime();
}

/** Chronological grace zone after close (even if a979b8c would suppress it). */
function inChronologicalGrace(leg: LegWindowSpec, at: Date): boolean {
  if (!leg.closedAt) return false;
  const t = at.getTime();
  const close = leg.closedAt.getTime();
  return t > close && t <= close + LEG_CLOSE_GRACE_MS;
}

async function main(): Promise<void> {
  const prisma = createPrisma();
  try {
    const okStructures = await prisma.structurePnl.findMany({
      where: {
        isSimulated: false,
        status: "closed",
        OR: [
          { attributionStatus: ATTRIBUTION_STATUS.OK },
          { attributionStatus: null },
        ],
      },
      select: {
        id: true,
        userId: true,
        botStructureId: true,
        attributionStatus: true,
        legs: {
          select: {
            botLegId: true,
            productId: true,
            openedAt: true,
            attributionFrom: true,
            closedAt: true,
          },
        },
      },
    });

    const userIds = [...new Set(okStructures.map((s) => s.userId))];
    const ledgerByUser = new Map<
      string,
      Array<{ productId: number | null; occurredAt: Date; amount: unknown }>
    >();

    for (const userId of userIds) {
      const rows = await prisma.deltaLedgerEntry.findMany({
        where: {
          userId,
          isSimulated: false,
          transactionType: { in: [...BILLING_TXN_TYPES] },
          productId: { not: null },
        },
        select: { productId: true, occurredAt: true, amount: true },
      });
      ledgerByUser.set(userId, rows);
    }

    let wouldBecomeSuspect = 0;
    let ambiguousTxnEvents = 0;
    const sample: Array<{
      userId: string;
      botStructureId: number;
      productId: number;
    }> = [];

    for (const structure of okStructures) {
      const specs: LegWindowSpec[] = structure.legs.map((leg) => ({
        botStructureId: structure.botStructureId,
        botLegId: leg.botLegId,
        productId: leg.productId,
        openedAt: leg.openedAt,
        attributionFrom: leg.attributionFrom,
        closedAt: leg.closedAt,
      }));

      const ledger = ledgerByUser.get(structure.userId) ?? [];
      let hit = false;

      for (const txn of ledger) {
        if (txn.productId == null) continue;
        const productLegs = specs.filter((l) => l.productId === txn.productId);
        if (productLegs.length < 2) continue;

        for (const graceLeg of productLegs) {
          if (!inChronologicalGrace(graceLeg, txn.occurredAt)) continue;
          const realOpenOthers = productLegs.filter(
            (other) =>
              !(
                other.botStructureId === graceLeg.botStructureId &&
                other.botLegId === graceLeg.botLegId
              ) && inRealWindow(other, txn.occurredAt),
          );
          if (realOpenOthers.length === 0) continue;
          // This is the silent-award-to-B pattern under current a979b8c rules.
          ambiguousTxnEvents += 1;
          hit = true;
          if (sample.length < 15) {
            sample.push({
              userId: structure.userId,
              botStructureId: structure.botStructureId,
              productId: txn.productId,
            });
          }
          break;
        }
        if (hit) break;
      }

      if (hit) wouldBecomeSuspect += 1;
    }

    console.log(
      JSON.stringify(
        {
          okStructuresScanned: okStructures.length,
          wouldBecomeSuspectIfBothMarked: wouldBecomeSuspect,
          ambiguousTxnEvents,
          sample,
        },
        null,
        2,
      ),
    );
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
