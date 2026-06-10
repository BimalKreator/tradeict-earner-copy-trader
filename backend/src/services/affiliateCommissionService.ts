import {
  CommissionLedgerStatus,
  InvoiceStatus,
  Role,
  SalesTier,
  type Prisma,
  type PrismaClient,
} from "@prisma/client";
import { PrismaClientKnownRequestError } from "@prisma/client/runtime/client";
import { startOfUtcDay } from "./dashboardMetricsService.js";
import {
  isSalesMemberRole,
  type SalesMemberRole,
} from "./affiliateMemberService.js";

/** Max partner commission as % of app revenue share for one profit event. */
export const MAX_PARTNER_COMMISSION_RATE_PCT = 8;

const EXECUTIVE_DIRECT_RATE = 5;
const MANAGER_UNDER_EXECUTIVE_RATE = 2;
const DIRECTOR_UNDER_EXECUTIVE_RATE = 1;
const MANAGER_DIRECT_RATE = 6;
const DIRECTOR_UNDER_MANAGER_RATE = 2;
const DIRECTOR_DIRECT_RATE = 8;

export type CommissionChainSlice = {
  beneficiaryUserId: string;
  commissionRate: number;
  beneficiaryTier: SalesTier;
};

type AncestorNode = {
  id: string;
  role: Role;
};

function roleToSalesTier(role: SalesMemberRole): SalesTier {
  if (role === Role.MANAGER) return SalesTier.MANAGER;
  if (role === Role.DIRECTOR) return SalesTier.DIRECTOR;
  return SalesTier.EXECUTIVE;
}

async function loadAncestorChain(
  prisma: PrismaClient,
  startParentId: string | null,
  maxDepth = 12,
): Promise<AncestorNode[]> {
  const out: AncestorNode[] = [];
  let currentId = startParentId;
  const seen = new Set<string>();

  for (let depth = 0; depth < maxDepth && currentId; depth += 1) {
    if (seen.has(currentId)) break;
    seen.add(currentId);

    const row = await prisma.user.findUnique({
      where: { id: currentId },
      select: { id: true, role: true, parentId: true },
    });
    if (!row) break;

    out.push({ id: row.id, role: row.role });
    currentId = row.parentId;
  }

  return out;
}

function findFirstAncestorWithRole(
  ancestors: AncestorNode[],
  role: Role,
): AncestorNode | undefined {
  return ancestors.find((a) => a.role === role);
}

function mergeDuplicateBeneficiaries(
  slices: CommissionChainSlice[],
): CommissionChainSlice[] {
  const merged = new Map<string, CommissionChainSlice>();
  for (const slice of slices) {
    const hit = merged.get(slice.beneficiaryUserId);
    if (!hit) {
      merged.set(slice.beneficiaryUserId, { ...slice });
      continue;
    }
    hit.commissionRate += slice.commissionRate;
  }
  return Array.from(merged.values());
}

function capTotalCommissionRate(
  slices: CommissionChainSlice[],
): CommissionChainSlice[] {
  const total = slices.reduce((sum, s) => sum + s.commissionRate, 0);
  if (total <= MAX_PARTNER_COMMISSION_RATE_PCT) {
    return slices;
  }
  const scale = MAX_PARTNER_COMMISSION_RATE_PCT / total;
  return slices.map((s) => ({
    ...s,
    commissionRate: Math.round(s.commissionRate * scale * 1e6) / 1e6,
  }));
}

/**
 * Build commission % slices from the acquiring partner up the `parentId` chain.
 * Rates are % of app revenue share (not gross trade PnL).
 */
export async function resolveCommissionChain(
  prisma: PrismaClient,
  acquiredById: string | null,
): Promise<CommissionChainSlice[]> {
  if (!acquiredById?.trim()) return [];

  const direct = await prisma.user.findUnique({
    where: { id: acquiredById.trim() },
    select: { id: true, role: true, parentId: true },
  });

  if (!direct || !isSalesMemberRole(direct.role)) {
    return [];
  }

  const ancestors = await loadAncestorChain(prisma, direct.parentId);
  const slices: CommissionChainSlice[] = [];

  if (direct.role === Role.EXECUTIVE) {
    slices.push({
      beneficiaryUserId: direct.id,
      commissionRate: EXECUTIVE_DIRECT_RATE,
      beneficiaryTier: SalesTier.EXECUTIVE,
    });

    const manager = findFirstAncestorWithRole(ancestors, Role.MANAGER);
    const director = findFirstAncestorWithRole(ancestors, Role.DIRECTOR);

    if (manager) {
      slices.push({
        beneficiaryUserId: manager.id,
        commissionRate: MANAGER_UNDER_EXECUTIVE_RATE,
        beneficiaryTier: SalesTier.MANAGER,
      });
    }

    if (director) {
      const directorRate = manager
        ? DIRECTOR_UNDER_EXECUTIVE_RATE
        : MANAGER_UNDER_EXECUTIVE_RATE + DIRECTOR_UNDER_EXECUTIVE_RATE;
      slices.push({
        beneficiaryUserId: director.id,
        commissionRate: directorRate,
        beneficiaryTier: SalesTier.DIRECTOR,
      });
    }
  } else if (direct.role === Role.MANAGER) {
    slices.push({
      beneficiaryUserId: direct.id,
      commissionRate: MANAGER_DIRECT_RATE,
      beneficiaryTier: SalesTier.MANAGER,
    });

    const director = findFirstAncestorWithRole(ancestors, Role.DIRECTOR);
    if (director) {
      slices.push({
        beneficiaryUserId: director.id,
        commissionRate: DIRECTOR_UNDER_MANAGER_RATE,
        beneficiaryTier: SalesTier.DIRECTOR,
      });
    }
  } else if (direct.role === Role.DIRECTOR) {
    slices.push({
      beneficiaryUserId: direct.id,
      commissionRate: DIRECTOR_DIRECT_RATE,
      beneficiaryTier: SalesTier.DIRECTOR,
    });
  }

  return capTotalCommissionRate(mergeDuplicateBeneficiaries(slices));
}

export type DistributeRevenueShareCommissionsArgs = {
  sourceUserId: string;
  pnlRecordId: string;
  /** App profit-share $ for this event (strategy profitShare % × booked profit). */
  appRevenueBase: number;
  /** Profit booking time — used for profitDate and unlockDate (+30d). */
  profitDate: Date;
};

/**
 * Insert EARNED commission ledger rows for one positive PnL / revenue-share event.
 */
export async function distributeRevenueShareCommissions(
  prisma: PrismaClient,
  args: DistributeRevenueShareCommissionsArgs,
): Promise<{ created: number; skipped: number }> {
  const appRevenueBase = args.appRevenueBase;
  if (!Number.isFinite(appRevenueBase) || appRevenueBase <= 0) {
    return { created: 0, skipped: 0 };
  }

  const source = await prisma.user.findUnique({
    where: { id: args.sourceUserId },
    select: { acquiredById: true },
  });
  if (!source?.acquiredById) {
    return { created: 0, skipped: 0 };
  }

  const chain = await resolveCommissionChain(prisma, source.acquiredById);
  if (chain.length === 0) {
    return { created: 0, skipped: 0 };
  }

  const profitDate = startOfUtcDay(args.profitDate);
  const unlockDate = new Date(profitDate);
  unlockDate.setUTCDate(unlockDate.getUTCDate() + 30);

  let created = 0;
  let skipped = 0;

  await prisma.$transaction(async (tx) => {
    for (const slice of chain) {
      if (slice.commissionRate <= 0) continue;

      const amount = appRevenueBase * (slice.commissionRate / 100);
      if (!Number.isFinite(amount) || amount <= 0) continue;

      const idempotencyKey = `${args.pnlRecordId}:${slice.beneficiaryUserId}:EARNED`;

      try {
        await tx.commissionLedger.create({
          data: {
            profitDate,
            sourceUserId: args.sourceUserId,
            beneficiaryUserId: slice.beneficiaryUserId,
            amount,
            appRevenueBase,
            commissionRate: slice.commissionRate,
            beneficiaryTier: slice.beneficiaryTier,
            status: CommissionLedgerStatus.EARNED,
            unlockDate,
            idempotencyKey,
            pnlRecordId: args.pnlRecordId,
          },
        });
        created += 1;
      } catch (err) {
        if (
          err instanceof PrismaClientKnownRequestError &&
          err.code === "P2002"
        ) {
          skipped += 1;
          continue;
        }
        throw err;
      }
    }
  });

  if (created > 0) {
    console.log(
      `[affiliateCommission] distributed sourceUser=${args.sourceUserId} pnlRecord=${args.pnlRecordId} ` +
        `base=$${appRevenueBase.toFixed(2)} rows=${created} skipped=${skipped}`,
    );
  }

  return { created, skipped };
}

/** Fire-and-forget wrapper — must not throw to callers. */
export async function triggerAffiliateCommissionDistribution(
  prisma: PrismaClient,
  args: DistributeRevenueShareCommissionsArgs,
): Promise<void> {
  try {
    await distributeRevenueShareCommissions(prisma, args);
  } catch (err) {
    console.error(
      `[affiliateCommission] distribution failed sourceUser=${args.sourceUserId} pnlRecord=${args.pnlRecordId}:`,
      err instanceof Error ? err.message : err,
    );
  }
}

/** UTC calendar month bounds for invoice `month` (1–12) / `year`. */
function invoiceMonthRange(
  month: number,
  year: number,
): { start: Date; end: Date } {
  const start = new Date(Date.UTC(year, month - 1, 1));
  const end = new Date(Date.UTC(year, month, 1));
  return { start, end };
}

/**
 * PnL rows whose app revenue share is covered by a (user, strategy, month) invoice.
 */
export async function resolvePnlRecordIdsForInvoice(
  prisma: PrismaClient,
  invoice: {
    userId: string;
    strategyId: string;
    month: number;
    year: number;
  },
): Promise<string[]> {
  const { start, end } = invoiceMonthRange(invoice.month, invoice.year);
  const rows = await prisma.pnLRecord.findMany({
    where: {
      userId: invoice.userId,
      strategyId: invoice.strategyId,
      commissionAmount: { gt: 0 },
      timestamp: { gte: start, lt: end },
    },
    select: { id: true },
  });
  return rows.map((r) => r.id);
}

/**
 * Move EARNED partner commissions to PAYABLE when the trader pays their invoice.
 * Matches ledger rows via `pnlRecordId` for the invoice billing month; falls back to
 * `profitDate` within the same month when no PnL rows are linked.
 */
export async function markCommissionsAsPayable(
  prisma: PrismaClient,
  invoiceId: string,
  paymentTransactionId: string | null,
): Promise<{ updated: number }> {
  const invoice = await prisma.invoice.findUnique({
    where: { id: invoiceId },
    select: {
      id: true,
      userId: true,
      strategyId: true,
      month: true,
      year: true,
      status: true,
    },
  });

  if (!invoice || invoice.status !== InvoiceStatus.PAID) {
    return { updated: 0 };
  }

  const pnlRecordIds = await resolvePnlRecordIdsForInvoice(prisma, invoice);
  const { start, end } = invoiceMonthRange(invoice.month, invoice.year);

  const where: Prisma.CommissionLedgerWhereInput = {
    sourceUserId: invoice.userId,
    status: CommissionLedgerStatus.EARNED,
    invoiceId: null,
  };

  if (pnlRecordIds.length > 0) {
    where.pnlRecordId = { in: pnlRecordIds };
  } else {
    where.profitDate = { gte: start, lt: end };
  }

  const payableAt = new Date();
  const result = await prisma.commissionLedger.updateMany({
    where,
    data: {
      status: CommissionLedgerStatus.PAYABLE,
      payableAt,
      invoiceId: invoice.id,
      ...(paymentTransactionId
        ? { paymentTransactionId }
        : {}),
    },
  });

  return { updated: result.count };
}

/** Async hook after invoice PAID — must not throw to payment / billing callers. */
export async function triggerMarkCommissionsAsPayable(
  prisma: PrismaClient,
  invoiceId: string,
  paymentTransactionId: string | null,
): Promise<void> {
  try {
    const { updated } = await markCommissionsAsPayable(
      prisma,
      invoiceId,
      paymentTransactionId,
    );
    if (updated > 0) {
      console.log(
        `[affiliate-webhook] marked ${updated} commission row(s) PAYABLE invoice=${invoiceId}`,
      );
    }
  } catch (err) {
    console.error(
      `[affiliate-webhook] error marking payable invoice=${invoiceId}:`,
      err instanceof Error ? err.message : err,
    );
  }
}
