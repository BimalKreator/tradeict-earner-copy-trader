import cron from "node-cron";
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
import {
  DEFAULT_PARTNER_COMMISSION_RATES,
  getPartnerCommissionRates,
  type PartnerCommissionRates,
} from "./partnerCommissionConfigService.js";

/** Default max partner commission % — overridden by admin SystemSettings. */
export const MAX_PARTNER_COMMISSION_RATE_PCT =
  DEFAULT_PARTNER_COMMISSION_RATES.maxTotalPct;

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
  maxTotalPct: number,
): CommissionChainSlice[] {
  const total = slices.reduce((sum, s) => sum + s.commissionRate, 0);
  if (total <= maxTotalPct) {
    return slices;
  }
  const scale = maxTotalPct / total;
  return slices.map((s) => ({
    ...s,
    commissionRate: Math.round(s.commissionRate * scale * 1e6) / 1e6,
  }));
}

/**
 * First upline partner id — used only for logging/diagnostics.
 * Commission resolution uses {@link resolveCommissionChain} with the full source profile.
 */
export function resolveCommissionChainEntryId(source: {
  role: Role;
  acquiredById: string | null;
  parentId: string | null;
}): string | null {
  if (source.role === Role.USER) {
    return source.acquiredById?.trim() || null;
  }
  if (source.role === Role.EXECUTIVE || source.role === Role.MANAGER) {
    return source.parentId?.trim() || null;
  }
  return null;
}

/** USER path — partner who acquired the trader gets "direct" tier rates + upline. */
async function resolveCommissionChainFromAcquirer(
  prisma: PrismaClient,
  chainEntryId: string,
  cfg: PartnerCommissionRates,
): Promise<CommissionChainSlice[]> {
  const direct = await prisma.user.findUnique({
    where: { id: chainEntryId.trim() },
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
      commissionRate: cfg.executiveDirectPct,
      beneficiaryTier: SalesTier.EXECUTIVE,
    });

    const manager = findFirstAncestorWithRole(ancestors, Role.MANAGER);
    const director = findFirstAncestorWithRole(ancestors, Role.DIRECTOR);

    if (manager) {
      slices.push({
        beneficiaryUserId: manager.id,
        commissionRate: cfg.managerUnderExecutivePct,
        beneficiaryTier: SalesTier.MANAGER,
      });
    }

    if (director) {
      const directorRate = manager
        ? cfg.directorUnderExecutivePct
        : cfg.managerUnderExecutivePct + cfg.directorUnderExecutivePct;
      slices.push({
        beneficiaryUserId: director.id,
        commissionRate: directorRate,
        beneficiaryTier: SalesTier.DIRECTOR,
      });
    }
  } else if (direct.role === Role.MANAGER) {
    slices.push({
      beneficiaryUserId: direct.id,
      commissionRate: cfg.managerDirectPct,
      beneficiaryTier: SalesTier.MANAGER,
    });

    const director = findFirstAncestorWithRole(ancestors, Role.DIRECTOR);
    if (director) {
      slices.push({
        beneficiaryUserId: director.id,
        commissionRate: cfg.directorUnderManagerPct,
        beneficiaryTier: SalesTier.DIRECTOR,
      });
    }
  } else if (direct.role === Role.DIRECTOR) {
    slices.push({
      beneficiaryUserId: direct.id,
      commissionRate: cfg.directorDirectPct,
      beneficiaryTier: SalesTier.DIRECTOR,
    });
  }

  return capTotalCommissionRate(
    mergeDuplicateBeneficiaries(slices),
    cfg.maxTotalPct,
  );
}

/**
 * EXECUTIVE / MANAGER trading their own account — pay upline via `parentId` only.
 * The trader never receives commission on their own PnL; rates are upline tiers,
 * not "direct acquisition" tiers (e.g. Director gets 2%, not 8%, when Manager trades).
 */
async function resolveCommissionChainFromPartnerSelfTrade(
  prisma: PrismaClient,
  source: {
    role: Role;
    parentId: string | null;
  },
  cfg: PartnerCommissionRates,
): Promise<CommissionChainSlice[]> {
  const ancestors = await loadAncestorChain(
    prisma,
    source.parentId?.trim() || null,
  );
  const slices: CommissionChainSlice[] = [];

  if (source.role === Role.EXECUTIVE) {
    const manager = findFirstAncestorWithRole(ancestors, Role.MANAGER);
    const director = findFirstAncestorWithRole(ancestors, Role.DIRECTOR);

    if (manager) {
      slices.push({
        beneficiaryUserId: manager.id,
        commissionRate: cfg.managerUnderExecutivePct,
        beneficiaryTier: SalesTier.MANAGER,
      });
    }

    if (director) {
      const directorRate = manager
        ? cfg.directorUnderExecutivePct
        : cfg.managerUnderExecutivePct + cfg.directorUnderExecutivePct;
      slices.push({
        beneficiaryUserId: director.id,
        commissionRate: directorRate,
        beneficiaryTier: SalesTier.DIRECTOR,
      });
    }
  } else if (source.role === Role.MANAGER) {
    const director = findFirstAncestorWithRole(ancestors, Role.DIRECTOR);
    if (director) {
      slices.push({
        beneficiaryUserId: director.id,
        commissionRate: cfg.directorUnderManagerPct,
        beneficiaryTier: SalesTier.DIRECTOR,
      });
    }
  }

  return capTotalCommissionRate(
    mergeDuplicateBeneficiaries(slices),
    cfg.maxTotalPct,
  );
}

export type CommissionChainSource = {
  role: Role;
  acquiredById: string | null;
  parentId: string | null;
};

/**
 * Build commission % slices for any trading account holder.
 * - USER: `acquiredById` partner chain (direct + upline rates)
 * - EXECUTIVE / MANAGER: `parentId` upline only (self-trade rates)
 * - DIRECTOR / ADMIN: no partner commissions
 */
export async function resolveCommissionChain(
  prisma: PrismaClient,
  source: CommissionChainSource,
  rates?: PartnerCommissionRates,
): Promise<CommissionChainSlice[]> {
  const cfg = rates ?? (await getPartnerCommissionRates(prisma));

  if (source.role === Role.ADMIN || source.role === Role.DIRECTOR) {
    return [];
  }

  if (source.role === Role.USER) {
    const entry = source.acquiredById?.trim() || null;
    if (!entry) return [];
    return resolveCommissionChainFromAcquirer(prisma, entry, cfg);
  }

  if (source.role === Role.EXECUTIVE || source.role === Role.MANAGER) {
    return resolveCommissionChainFromPartnerSelfTrade(prisma, source, cfg);
  }

  return [];
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
    console.log(
      `[affiliateCommission] skip distribution sourceUser=${args.sourceUserId} ` +
        `pnlRecord=${args.pnlRecordId} — appRevenueBase<=0 (${appRevenueBase})`,
    );
    return { created: 0, skipped: 0 };
  }

  const source = await prisma.user.findUnique({
    where: { id: args.sourceUserId },
    select: { role: true, acquiredById: true, parentId: true },
  });
  if (!source) {
    console.warn(
      `[affiliateCommission] skip distribution — source user not found id=${args.sourceUserId}`,
    );
    return { created: 0, skipped: 0 };
  }

  const chain = await resolveCommissionChain(prisma, source);
  if (chain.length === 0) {
    console.log(
      `[affiliateCommission] no commission chain sourceUser=${args.sourceUserId} ` +
        `role=${source.role} acquiredById=${source.acquiredById ?? "none"} ` +
        `parentId=${source.parentId ?? "none"} appRevenueBase=$${appRevenueBase.toFixed(2)}`,
    );
    return { created: 0, skipped: 0 };
  }

  console.log(
    `[affiliateCommission] calculating commissions sourceUser=${args.sourceUserId} ` +
      `pnlRecord=${args.pnlRecordId} appRevenueBase=$${appRevenueBase.toFixed(2)} ` +
      `chainLen=${chain.length} ` +
      chain
        .map(
          (s) =>
            `partner=${s.beneficiaryUserId} tier=${s.beneficiaryTier} rate=${s.commissionRate}%`,
        )
        .join(" | "),
  );

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
        const row = await tx.commissionLedger.create({
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
        console.log(
          `[affiliateCommission] ledger insert id=${row.id} status=EARNED ` +
            `partnerId=${slice.beneficiaryUserId} amount=$${amount.toFixed(4)} ` +
            `rate=${slice.commissionRate}% tier=${slice.beneficiaryTier} ` +
            `sourceUser=${args.sourceUserId} pnlRecord=${args.pnlRecordId}`,
        );
      } catch (err) {
        if (
          err instanceof PrismaClientKnownRequestError &&
          err.code === "P2002"
        ) {
          skipped += 1;
          console.log(
            `[affiliateCommission] ledger skip duplicate status=EARNED ` +
              `partnerId=${slice.beneficiaryUserId} amount=$${amount.toFixed(4)} ` +
              `sourceUser=${args.sourceUserId} key=${idempotencyKey}`,
          );
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

/** Remove unpaid EARNED partner commissions when trader net PnL is not positive. */
export async function voidPendingEarnedCommissionsForSourceUser(
  prisma: PrismaClient,
  sourceUserId: string,
): Promise<number> {
  const result = await prisma.commissionLedger.deleteMany({
    where: {
      sourceUserId,
      status: CommissionLedgerStatus.EARNED,
      invoiceId: null,
    },
  });
  if (result.count > 0) {
    console.log(
      `[affiliateCommission] voided ${result.count} EARNED row(s) sourceUser=${sourceUserId} — net PnL ≤ 0`,
    );
  }
  return result.count;
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

/**
 * Move PAYABLE commissions past their 30-day unlock window to WITHDRAWABLE.
 */
export async function processMaturedCommissions(
  prisma: PrismaClient,
): Promise<{ updated: number }> {
  const now = new Date();
  const result = await prisma.commissionLedger.updateMany({
    where: {
      status: CommissionLedgerStatus.PAYABLE,
      unlockDate: { lte: now },
    },
    data: {
      status: CommissionLedgerStatus.WITHDRAWABLE,
      withdrawableAt: now,
    },
  });

  console.log(
    `[affiliate-cron] Processed ${result.count} matured commissions to WITHDRAWABLE state.`,
  );

  return { updated: result.count };
}

/** Daily UTC job — matures PAYABLE → WITHDRAWABLE after unlockDate. */
export function initAffiliateCommissionCronJobs(prisma: PrismaClient): void {
  cron.schedule(
    "5 0 * * *",
    () => {
      void processMaturedCommissions(prisma).catch((err) => {
        console.error(
          "[affiliate-cron] Maturity run failed:",
          err instanceof Error ? err.message : err,
        );
      });
    },
    { timezone: "Etc/UTC" },
  );

  console.log(
    "[affiliate-cron] Cron: commission maturity @ 00:05 UTC daily",
  );
}
