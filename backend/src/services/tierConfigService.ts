import { SalesTier, type PrismaClient } from "@prisma/client";
import {
  getPartnerCommissionRates,
  type PartnerCommissionRates,
} from "./partnerCommissionConfigService.js";

const TIER_ORDER: SalesTier[] = [
  SalesTier.EXECUTIVE,
  SalesTier.MANAGER,
  SalesTier.SENIOR_MANAGER,
];

/** Display-only commission columns — sourced from SystemSettings, not TierConfig DB columns. */
export type TierCommissionDisplay = {
  directCommissionRate: number;
  teamCommissionRate: number;
  networkCommissionRate: number;
};

export type TierConfigDto = {
  id: string;
  tierLevel: SalesTier;
  minReferralsRequired: number;
  benefits: string[];
} & TierCommissionDisplay;

/** Partner-facing tier row — no internal database ids. */
export type PublicTierConfigDto = {
  tierLevel: SalesTier;
  minReferralsRequired: number;
  benefits: string[];
} & TierCommissionDisplay;

function tierCommissionDisplayFromPartnerRates(
  tierLevel: SalesTier,
  rates: PartnerCommissionRates,
): TierCommissionDisplay {
  switch (tierLevel) {
    case SalesTier.EXECUTIVE:
      return {
        directCommissionRate: rates.executiveDirectPct,
        teamCommissionRate: rates.managerUnderExecutivePct,
        networkCommissionRate: rates.directorUnderExecutivePct,
      };
    case SalesTier.MANAGER:
      return {
        directCommissionRate: rates.managerDirectPct,
        teamCommissionRate: rates.directorUnderManagerPct,
        networkCommissionRate: 0,
      };
    case SalesTier.SENIOR_MANAGER:
      return {
        directCommissionRate: rates.directorDirectPct,
        teamCommissionRate: 0,
        networkCommissionRate: 0,
      };
    default:
      return {
        directCommissionRate: 0,
        teamCommissionRate: 0,
        networkCommissionRate: 0,
      };
  }
}

export function toPublicTierConfig(row: TierConfigDto): PublicTierConfigDto {
  return {
    tierLevel: row.tierLevel,
    directCommissionRate: row.directCommissionRate,
    teamCommissionRate: row.teamCommissionRate,
    networkCommissionRate: row.networkCommissionRate,
    minReferralsRequired: row.minReferralsRequired,
    benefits: row.benefits,
  };
}

export async function listPublicTierConfigs(
  prisma: PrismaClient,
): Promise<PublicTierConfigDto[]> {
  const rows = await listTierConfigs(prisma);
  return rows.map(toPublicTierConfig);
}

export type TierConfigUpdateInput = {
  tierLevel: SalesTier;
  minReferralsRequired: number;
  benefits: string[];
};

type ServiceError = { ok: false; status: number; error: string };
type ServiceOk<T> = { ok: true; data: T };

function parseBenefits(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === "string")
    .map((s) => s.trim())
    .filter(Boolean);
}

function mapRow(
  row: {
    id: string;
    tierLevel: SalesTier;
    minReferralsRequired: number;
    benefits: unknown;
  },
  rates: PartnerCommissionRates,
): TierConfigDto {
  return {
    id: row.id,
    tierLevel: row.tierLevel,
    minReferralsRequired: row.minReferralsRequired,
    benefits: parseBenefits(row.benefits),
    ...tierCommissionDisplayFromPartnerRates(row.tierLevel, rates),
  };
}

function isSalesTier(value: string): value is SalesTier {
  return (
    value === SalesTier.EXECUTIVE ||
    value === SalesTier.MANAGER ||
    value === SalesTier.SENIOR_MANAGER
  );
}

export async function listTierConfigs(
  prisma: PrismaClient,
): Promise<TierConfigDto[]> {
  const [rows, partnerRates] = await Promise.all([
    prisma.tierConfig.findMany({
      orderBy: { tierLevel: "asc" },
    }),
    getPartnerCommissionRates(prisma),
  ]);

  const byTier = new Map(rows.map((r) => [r.tierLevel, r]));
  return TIER_ORDER.map((tier) => {
    const row = byTier.get(tier);
    if (row) return mapRow(row, partnerRates);
    return {
      id: "",
      tierLevel: tier,
      minReferralsRequired: tier === SalesTier.EXECUTIVE ? 0 : 10,
      benefits: [],
      ...tierCommissionDisplayFromPartnerRates(tier, partnerRates),
    };
  });
}

export async function updateTierConfigs(
  prisma: PrismaClient,
  tiers: TierConfigUpdateInput[],
): Promise<ServiceOk<{ tiers: TierConfigDto[] }> | ServiceError> {
  if (tiers.length === 0) {
    return { ok: false, status: 400, error: "At least one tier update is required" };
  }

  const seen = new Set<SalesTier>();
  const normalized: TierConfigUpdateInput[] = [];

  for (const tier of tiers) {
    const levelRaw =
      typeof tier.tierLevel === "string"
        ? tier.tierLevel.trim().toUpperCase()
        : "";
    if (!isSalesTier(levelRaw)) {
      return {
        ok: false,
        status: 400,
        error: "tierLevel must be EXECUTIVE, MANAGER, or SENIOR_MANAGER",
      };
    }
    if (seen.has(levelRaw)) {
      return { ok: false, status: 400, error: `Duplicate tierLevel ${levelRaw}` };
    }
    seen.add(levelRaw);

    const minReferrals = Number(tier.minReferralsRequired);
    if (!Number.isInteger(minReferrals) || minReferrals < 0) {
      return {
        ok: false,
        status: 400,
        error: "minReferralsRequired must be a non-negative integer",
      };
    }

    const benefits = Array.isArray(tier.benefits)
      ? tier.benefits
          .filter((b): b is string => typeof b === "string")
          .map((b) => b.trim())
          .filter(Boolean)
      : [];

    normalized.push({
      tierLevel: levelRaw,
      minReferralsRequired: minReferrals,
      benefits,
    });
  }

  await prisma.$transaction(
    normalized.map((tier) =>
      prisma.tierConfig.upsert({
        where: { tierLevel: tier.tierLevel },
        create: {
          tierLevel: tier.tierLevel,
          // Deprecated columns — kept for schema compatibility; rates live in SystemSettings.
          directCommissionRate: 0,
          teamCommissionRate: 0,
          networkCommissionRate: 0,
          minReferralsRequired: tier.minReferralsRequired,
          benefits: tier.benefits,
        },
        update: {
          minReferralsRequired: tier.minReferralsRequired,
          benefits: tier.benefits,
        },
      }),
    ),
  );

  const updated = await listTierConfigs(prisma);
  return { ok: true, data: { tiers: updated } };
}
