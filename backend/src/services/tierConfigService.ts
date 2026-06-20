import { SalesTier, type PrismaClient } from "@prisma/client";

const TIER_ORDER: SalesTier[] = [
  SalesTier.EXECUTIVE,
  SalesTier.MANAGER,
  SalesTier.SENIOR_MANAGER,
];

export type TierConfigDto = {
  id: string;
  tierLevel: SalesTier;
  directCommissionRate: number;
  teamCommissionRate: number;
  networkCommissionRate: number;
  minReferralsRequired: number;
  benefits: string[];
};

/** Partner-facing tier row — no internal database ids. */
export type PublicTierConfigDto = {
  tierLevel: SalesTier;
  directCommissionRate: number;
  teamCommissionRate: number;
  networkCommissionRate: number;
  minReferralsRequired: number;
  benefits: string[];
};

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
  directCommissionRate: number;
  teamCommissionRate: number;
  networkCommissionRate: number;
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

function mapRow(row: {
  id: string;
  tierLevel: SalesTier;
  directCommissionRate: number;
  teamCommissionRate: number;
  networkCommissionRate: number;
  minReferralsRequired: number;
  benefits: unknown;
}): TierConfigDto {
  return {
    id: row.id,
    tierLevel: row.tierLevel,
    directCommissionRate: row.directCommissionRate,
    teamCommissionRate: row.teamCommissionRate,
    networkCommissionRate: row.networkCommissionRate,
    minReferralsRequired: row.minReferralsRequired,
    benefits: parseBenefits(row.benefits),
  };
}

function clampRate(value: number, label: string): number | null {
  if (!Number.isFinite(value) || value < 0 || value > 100) {
    return null;
  }
  return Math.round(value * 100) / 100;
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
  const rows = await prisma.tierConfig.findMany({
    orderBy: { tierLevel: "asc" },
  });

  const byTier = new Map(rows.map((r) => [r.tierLevel, mapRow(r)]));
  return TIER_ORDER.map(
    (tier) =>
      byTier.get(tier) ?? {
        id: "",
        tierLevel: tier,
        directCommissionRate: 5,
        teamCommissionRate: 2,
        networkCommissionRate: 1,
        minReferralsRequired: tier === SalesTier.EXECUTIVE ? 0 : 10,
        benefits: [],
      },
  );
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

    const direct = clampRate(Number(tier.directCommissionRate), "directCommissionRate");
    const team = clampRate(Number(tier.teamCommissionRate), "teamCommissionRate");
    const network = clampRate(
      Number(tier.networkCommissionRate),
      "networkCommissionRate",
    );
    if (direct == null || team == null || network == null) {
      return {
        ok: false,
        status: 400,
        error: "Commission rates must be numbers between 0 and 100",
      };
    }

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
      directCommissionRate: direct,
      teamCommissionRate: team,
      networkCommissionRate: network,
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
          directCommissionRate: tier.directCommissionRate,
          teamCommissionRate: tier.teamCommissionRate,
          networkCommissionRate: tier.networkCommissionRate,
          minReferralsRequired: tier.minReferralsRequired,
          benefits: tier.benefits,
        },
        update: {
          directCommissionRate: tier.directCommissionRate,
          teamCommissionRate: tier.teamCommissionRate,
          networkCommissionRate: tier.networkCommissionRate,
          minReferralsRequired: tier.minReferralsRequired,
          benefits: tier.benefits,
        },
      }),
    ),
  );

  const updated = await listTierConfigs(prisma);
  return { ok: true, data: { tiers: updated } };
}
