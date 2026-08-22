/**
 * One-off backfill: set leg attribution_from so pre-fix entry fills fall
 * inside the attribution window, then recompute structure P&L.
 *
 * Default is dry-run (no DB writes). Pass --apply to persist changes.
 *
 * Run from backend/:
 *   npx ts-node src/scripts/repairPreFixLegWindows.ts
 *   npx ts-node src/scripts/repairPreFixLegWindows.ts --apply
 *   npx ts-node src/scripts/repairPreFixLegWindows.ts --apply --user-id=<uuid>
 *   npx ts-node src/scripts/repairPreFixLegWindows.ts --lookback-seconds=45
 */
import "dotenv/config";
import pg from "pg";
import { PrismaPg } from "@prisma/adapter-pg";
import { Prisma, PrismaClient } from "@prisma/client";
import {
  ATTRIBUTION_STATUS,
  ledgerTxnMatchesLegWindow,
  recomputeStructurePnlForUsers,
} from "../services/structurePnlService.js";

const BOT_BASE_URL = process.env.BOT_BASE_URL ?? "http://127.0.0.1:8000";
const BOT_TIMEOUT_MS = 10_000;
const DEFAULT_LOOKBACK_SECONDS = 30;
const OPENED_AT_OFFSET_MS = 1_000;

type CashflowRow = {
  deltaUuid: string;
  productId: number;
  transactionType: string;
  amount: Prisma.Decimal;
  occurredAt: Date;
};

type LegWindow = {
  productId: number;
  attributionFrom: Date;
  closedAt: Date | null;
};

type LegWindowContext = LegWindow & {
  /** Actual leg open time — used for candidate search and exit sign, not window start. */
  openedAt: Date;
};

type RepairCandidate = {
  deltaUuid: string;
  occurredAt: Date;
  amount: number;
};

type LegRepairPlan = {
  legId: string;
  botLegId: number;
  side: string;
  openedAt: Date;
  oldAttributionFrom: Date;
  newAttributionFrom: Date;
  candidate: RepairCandidate;
  oldLegPnl: number;
  newLegPnl: number;
};

type LegSkip = {
  botLegId: number;
  reason: string;
};

type StructureRepairPlan = {
  structureId: string;
  botStructureId: number;
  userId: string;
  oldStructurePnl: number;
  newStructurePnl: number;
  legRepairs: LegRepairPlan[];
  legSkips: LegSkip[];
};

function parseArgs(argv: string[]): {
  apply: boolean;
  lookbackSeconds: number;
  userId?: string;
} {
  let apply = false;
  let lookbackSeconds = DEFAULT_LOOKBACK_SECONDS;
  let userId: string | undefined;

  for (const arg of argv) {
    if (arg === "--apply") {
      apply = true;
    } else if (arg.startsWith("--lookback-seconds=")) {
      const raw = arg.slice("--lookback-seconds=".length);
      const n = parseInt(raw, 10);
      if (Number.isFinite(n) && n > 0) lookbackSeconds = n;
    } else if (arg.startsWith("--user-id=")) {
      const raw = arg.slice("--user-id=".length).trim();
      if (raw) userId = raw;
    } else if (arg === "--help" || arg === "-h") {
      console.log(`Usage: repairPreFixLegWindows.ts [--apply] [--lookback-seconds=30] [--user-id=<uuid>]`);
      process.exit(0);
    }
  }

  const out: {
    apply: boolean;
    lookbackSeconds: number;
    userId?: string;
  } = { apply, lookbackSeconds };
  if (userId) out.userId = userId;
  return out;
}

function dec(value: Prisma.Decimal | null | undefined): number {
  if (value == null) return 0;
  return value.toNumber();
}

function legRealizedFromTotals(totals: {
  gross: number;
  commission: number;
}): number {
  return totals.gross + totals.commission;
}

function computeLegTotals(
  ledger: CashflowRow[],
  leg: LegWindow,
): {
  gross: number;
  commission: number;
  matchedTxnCount: number;
  cashflowHasPositive: boolean;
  cashflowHasNegative: boolean;
} {
  let gross = 0;
  let commission = 0;
  let matchedTxnCount = 0;
  let cashflowHasPositive = false;
  let cashflowHasNegative = false;

  for (const txn of ledger) {
    if (!ledgerTxnMatchesLegWindow(txn, leg)) continue;
    matchedTxnCount += 1;
    const tt = txn.transactionType.toLowerCase();
    if (tt === "cashflow") {
      const amt = txn.amount.toNumber();
      gross += amt;
      if (amt > 0) cashflowHasPositive = true;
      if (amt < 0) cashflowHasNegative = true;
    } else if (tt === "commission") {
      commission += txn.amount.toNumber();
    }
  }

  return {
    gross,
    commission,
    matchedTxnCount,
    cashflowHasPositive,
    cashflowHasNegative,
  };
}

function exitCashflowSign(
  ledger: CashflowRow[],
  leg: LegWindowContext,
): number | null {
  const rows = ledger.filter(
    (txn) =>
      txn.productId === leg.productId &&
      txn.transactionType.toLowerCase() === "cashflow" &&
      ledgerTxnMatchesLegWindow(txn, leg) &&
      txn.occurredAt >= leg.openedAt,
  );
  if (rows.length === 0) return null;
  rows.sort((a, b) => b.occurredAt.getTime() - a.occurredAt.getTime());
  const amt = rows[0]!.amount.toNumber();
  if (amt === 0) return null;
  return amt > 0 ? 1 : -1;
}

function entrySignMatchesSide(side: string, amount: number): boolean {
  const normalized = side.toLowerCase();
  if (normalized.includes("sell") || normalized === "short") {
    return amount > 0;
  }
  if (normalized.includes("buy") || normalized === "long") {
    return amount < 0;
  }
  return true;
}

function findEntryCandidate(
  ledger: CashflowRow[],
  leg: LegWindowContext & { side: string },
  lookbackSeconds: number,
): { candidate: RepairCandidate | null; reason: string | null } {
  const lookbackMs = lookbackSeconds * 1_000;
  const preEntry = ledger
    .filter(
      (txn) =>
        txn.productId === leg.productId &&
        txn.transactionType.toLowerCase() === "cashflow" &&
        txn.occurredAt < leg.openedAt,
    )
    .sort((a, b) => b.occurredAt.getTime() - a.occurredAt.getTime());

  if (preEntry.length === 0) {
    return { candidate: null, reason: "no cashflow row before leg.openedAt" };
  }

  const candidateRow = preEntry[0]!;
  const candidate: RepairCandidate = {
    deltaUuid: candidateRow.deltaUuid,
    occurredAt: candidateRow.occurredAt,
    amount: candidateRow.amount.toNumber(),
  };

  const ageMs = leg.openedAt.getTime() - candidate.occurredAt.getTime();
  if (ageMs > lookbackMs) {
    return {
      candidate: null,
      reason: `candidate too old (${(ageMs / 1000).toFixed(1)}s > ${lookbackSeconds}s lookback)`,
    };
  }

  const exitSign = exitCashflowSign(ledger, leg);
  if (exitSign == null) {
    return { candidate: null, reason: "no exit cashflow in current leg window" };
  }

  const entrySign = candidate.amount > 0 ? 1 : candidate.amount < 0 ? -1 : 0;
  if (entrySign === 0 || entrySign === exitSign) {
    return {
      candidate: null,
      reason: `entry sign does not oppose exit (entry=${candidate.amount}, exitSign=${exitSign})`,
    };
  }

  if (!entrySignMatchesSide(leg.side, candidate.amount)) {
    return {
      candidate: null,
      reason: `entry sign inconsistent with leg side "${leg.side}" (amount=${candidate.amount})`,
    };
  }

  const between = ledger.filter(
    (txn) =>
      txn.productId === leg.productId &&
      txn.transactionType.toLowerCase() === "cashflow" &&
      txn.occurredAt > candidate.occurredAt &&
      txn.occurredAt < leg.openedAt,
  );
  if (between.length > 0) {
    return {
      candidate: null,
      reason: `${between.length} other cashflow row(s) between candidate and leg.openedAt`,
    };
  }

  return { candidate, reason: null };
}

function isLegAlreadyRepaired(
  currentAttributionFrom: Date | null,
  openedAt: Date,
  candidateOccurredAt: Date,
): boolean {
  const target = new Date(candidateOccurredAt.getTime() - OPENED_AT_OFFSET_MS);
  const current = currentAttributionFrom ?? openedAt;
  return Math.abs(current.getTime() - target.getTime()) <= 500;
}

async function patchBotLegAttributionFrom(
  botLegId: number,
  attributionFrom: Date,
): Promise<{ ok: boolean; error?: string }> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), BOT_TIMEOUT_MS);
    const res = await fetch(
      `${BOT_BASE_URL}/api/structures/legs/${botLegId}/attribution-from`,
      {
        method: "PATCH",
        signal: controller.signal,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          attribution_from: attributionFrom.toISOString(),
        }),
      },
    );
    clearTimeout(timer);
    if (res.ok) return { ok: true };
    let detail = String(res.status);
    try {
      const body = (await res.json()) as { detail?: unknown };
      if (body.detail != null) detail = String(body.detail);
    } catch {
      // ignore
    }
    return { ok: false, error: detail };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

async function loadUserLedger(
  prisma: PrismaClient,
  userId: string,
): Promise<CashflowRow[]> {
  const rows = await prisma.deltaLedgerEntry.findMany({
    where: {
      userId,
      transactionType: { in: ["cashflow", "commission"] },
      productId: { not: null },
    },
    orderBy: { occurredAt: "asc" },
    select: {
      deltaUuid: true,
      productId: true,
      transactionType: true,
      amount: true,
      occurredAt: true,
    },
  });

  return rows.map((row) => ({
    deltaUuid: row.deltaUuid,
    productId: row.productId!,
    transactionType: row.transactionType,
    amount: row.amount,
    occurredAt: row.occurredAt,
  }));
}

async function buildStructurePlan(
  prisma: PrismaClient,
  ledger: CashflowRow[],
  structure: {
    id: string;
    userId: string;
    botStructureId: number;
    realizedPnl: Prisma.Decimal | null;
    legs: Array<{
      id: string;
      botLegId: number;
      productId: number;
      side: string;
      openedAt: Date;
      attributionFrom: Date | null;
      closedAt: Date | null;
      realizedPnl: Prisma.Decimal | null;
    }>;
  },
  lookbackSeconds: number,
): Promise<StructureRepairPlan> {
  const legRepairs: LegRepairPlan[] = [];
  const legSkips: LegSkip[] = [];
  const proposedLegWindows = new Map<number, LegWindow>();

  for (const leg of structure.legs) {
    if (!leg.closedAt) {
      legSkips.push({ botLegId: leg.botLegId, reason: "leg not closed" });
      proposedLegWindows.set(leg.botLegId, {
        productId: leg.productId,
        attributionFrom: leg.attributionFrom ?? leg.openedAt,
        closedAt: leg.closedAt,
      });
      continue;
    }

    const currentWindowStart = leg.attributionFrom ?? leg.openedAt;
    const currentWindow: LegWindowContext = {
      productId: leg.productId,
      attributionFrom: currentWindowStart,
      openedAt: leg.openedAt,
      closedAt: leg.closedAt,
    };
    const oldTotals = computeLegTotals(ledger, currentWindow);
    const oldLegPnl = legRealizedFromTotals(oldTotals);

    const { candidate, reason } = findEntryCandidate(
      ledger,
      {
        ...currentWindow,
        side: leg.side,
      },
      lookbackSeconds,
    );

    if (!candidate) {
      legSkips.push({
        botLegId: leg.botLegId,
        reason: reason ?? "no acceptable entry candidate",
      });
      proposedLegWindows.set(leg.botLegId, currentWindow);
      continue;
    }

    const newAttributionFrom = new Date(
      candidate.occurredAt.getTime() - OPENED_AT_OFFSET_MS,
    );
    if (
      isLegAlreadyRepaired(
        leg.attributionFrom,
        leg.openedAt,
        candidate.occurredAt,
      )
    ) {
      legSkips.push({
        botLegId: leg.botLegId,
        reason: "already repaired (attributionFrom matches candidate)",
      });
      proposedLegWindows.set(leg.botLegId, currentWindow);
      continue;
    }

    const newWindow: LegWindow = {
      productId: leg.productId,
      attributionFrom: newAttributionFrom,
      closedAt: leg.closedAt,
    };
    const newTotals = computeLegTotals(ledger, newWindow);
    const newLegPnl = legRealizedFromTotals(newTotals);

    legRepairs.push({
      legId: leg.id,
      botLegId: leg.botLegId,
      side: leg.side,
      openedAt: leg.openedAt,
      oldAttributionFrom: currentWindowStart,
      newAttributionFrom,
      candidate,
      oldLegPnl,
      newLegPnl,
    });
    proposedLegWindows.set(leg.botLegId, newWindow);
  }

  let oldStructurePnl = 0;
  let newStructurePnl = 0;
  for (const leg of structure.legs) {
    if (!leg.closedAt) continue;
    const window = proposedLegWindows.get(leg.botLegId);
    if (!window) continue;
    const repair = legRepairs.find((r) => r.botLegId === leg.botLegId);
    if (repair) {
      oldStructurePnl += repair.oldLegPnl;
      newStructurePnl += repair.newLegPnl;
    } else {
      const totals = computeLegTotals(ledger, window);
      const pnl = legRealizedFromTotals(totals);
      oldStructurePnl += pnl;
      newStructurePnl += pnl;
    }
  }

  if (structure.realizedPnl != null && legRepairs.length === 0) {
    oldStructurePnl = dec(structure.realizedPnl);
    newStructurePnl = dec(structure.realizedPnl);
  }

  return {
    structureId: structure.id,
    botStructureId: structure.botStructureId,
    userId: structure.userId,
    oldStructurePnl,
    newStructurePnl,
    legRepairs,
    legSkips,
  };
}

function printStructurePlan(plan: StructureRepairPlan, dryRun: boolean): void {
  console.log(
    `\nStructure #${plan.botStructureId} user=${plan.userId} ` +
      `[${dryRun ? "DRY-RUN" : "APPLY"}]`,
  );
  console.log(
    `  structure realizedPnl: ${plan.oldStructurePnl.toFixed(6)} -> ${plan.newStructurePnl.toFixed(6)}`,
  );

  for (const repair of plan.legRepairs) {
    console.log(`  leg ${repair.botLegId} (${repair.side}):`);
    console.log(`    openedAt: ${repair.openedAt.toISOString()} (unchanged)`);
    console.log(
      `    attributionFrom: ${repair.oldAttributionFrom.toISOString()} -> ${repair.newAttributionFrom.toISOString()}`,
    );
    console.log(
      `    candidate txn: ${repair.candidate.deltaUuid} @ ${repair.candidate.occurredAt.toISOString()} amount=${repair.candidate.amount}`,
    );
    console.log(
      `    leg realizedPnl: ${repair.oldLegPnl.toFixed(6)} -> ${repair.newLegPnl.toFixed(6)}`,
    );
  }

  for (const skip of plan.legSkips) {
    console.log(`  leg ${skip.botLegId}: SKIP — ${skip.reason}`);
  }
}

async function applyStructureRepairs(
  prisma: PrismaClient,
  plan: StructureRepairPlan,
): Promise<{ appliedLegs: number; botPatchFailures: string[] }> {
  let appliedLegs = 0;
  const botPatchFailures: string[] = [];

  for (const repair of plan.legRepairs) {
    const botPatch = await patchBotLegAttributionFrom(
      repair.botLegId,
      repair.newAttributionFrom,
    );
    if (!botPatch.ok) {
      botPatchFailures.push(
        `leg ${repair.botLegId}: bot PATCH failed — ${botPatch.error ?? "unknown"}`,
      );
      console.warn(
        `[repair] bot PATCH failed leg=${repair.botLegId}: ${botPatch.error ?? "unknown"} — skipping DB update for this leg`,
      );
      continue;
    }

    await prisma.structureLegPnl.update({
      where: { id: repair.legId },
      data: { attributionFrom: repair.newAttributionFrom },
    });
    appliedLegs += 1;
  }

  return { appliedLegs, botPatchFailures };
}

async function main(): Promise<void> {
  const { apply, lookbackSeconds, userId } = parseArgs(process.argv.slice(2));
  const dryRun = !apply;

  console.log(
    `[repair-pre-fix-legs] mode=${dryRun ? "DRY-RUN" : "APPLY"} ` +
      `lookback=${lookbackSeconds}s bot=${BOT_BASE_URL}`,
  );

  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    console.error("DATABASE_URL is required");
    process.exit(1);
  }

  const pool = new pg.Pool({ connectionString });
  const adapter = new PrismaPg(pool);
  const prisma = new PrismaClient({ adapter });

  try {
    const structures = await prisma.structurePnl.findMany({
      where: {
        attributionStatus: ATTRIBUTION_STATUS.SUSPECT_INCOMPLETE,
        isSimulated: false,
        ...(userId ? { userId } : {}),
      },
      orderBy: [{ userId: "asc" }, { botStructureId: "asc" }],
      include: {
        legs: { orderBy: { botLegId: "asc" } },
      },
    });

    console.log(`Found ${structures.length} SUSPECT_INCOMPLETE structure(s)`);
    if (structures.length === 0) {
      return;
    }

    const ledgerByUser = new Map<string, CashflowRow[]>();
    const plans: StructureRepairPlan[] = [];

    for (const structure of structures) {
      let ledger = ledgerByUser.get(structure.userId);
      if (!ledger) {
        ledger = await loadUserLedger(prisma, structure.userId);
        ledgerByUser.set(structure.userId, ledger);
      }

      const plan = await buildStructurePlan(
        prisma,
        ledger,
        structure,
        lookbackSeconds,
      );
      plans.push(plan);
      printStructurePlan(plan, dryRun);
    }

    if (dryRun) {
      console.log("\nDry-run complete — no changes written. Re-run with --apply to persist.");
      return;
    }

    const usersToRecompute = new Set<string>();
    let totalAppliedLegs = 0;

    for (const plan of plans) {
      if (plan.legRepairs.length === 0) continue;
      const { appliedLegs, botPatchFailures } = await applyStructureRepairs(
        prisma,
        plan,
      );
      totalAppliedLegs += appliedLegs;
      if (appliedLegs > 0) {
        usersToRecompute.add(plan.userId);
      }
      if (botPatchFailures.length > 0) {
        for (const msg of botPatchFailures) {
          console.warn(`[repair] ${msg}`);
        }
      }
    }

    console.log(`\nApplied attributionFrom repairs to ${totalAppliedLegs} leg(s)`);

    for (const uid of usersToRecompute) {
      console.log(`[repair] Recomputing structure P&L for user=${uid} ...`);
      const result = await recomputeStructurePnlForUsers(prisma, { userId: uid });
      const summary = result[uid];
      if (summary) {
        console.log(
          `[repair] user=${uid} structures=${summary.structures} closed=${summary.closed} ` +
            `realizedTotal=${summary.realizedTotal.toFixed(6)} unmatchedTxns=${summary.unmatchedTxns}`,
        );
      }
    }

    console.log("\nApply complete.");
  } finally {
    await prisma.$disconnect();
    await pool.end();
  }
}

main().catch((err) => {
  console.error("[repair-pre-fix-legs] fatal:", err);
  process.exit(1);
});
