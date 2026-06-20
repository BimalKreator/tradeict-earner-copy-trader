import {
  AffiliateProfileStatus,
  Role,
  SalesTier,
  SubscriptionStatus,
  UserStatus,
  type PrismaClient,
} from "@prisma/client";
import {
  isSalesMemberRole,
  validateParentForSalesRole,
  type SalesMemberRole,
} from "./affiliateMemberService.js";
import {
  listPublicTierConfigs,
  type PublicTierConfigDto,
} from "./tierConfigService.js";

const TIER_ORDER: SalesTier[] = [
  SalesTier.EXECUTIVE,
  SalesTier.MANAGER,
  SalesTier.SENIOR_MANAGER,
];

export type TierUpgradeEvaluation = {
  sponsorId: string;
  previousRole: Role;
  newRole: Role | null;
  directActiveReferrals: number;
  requiredForNextTier: number | null;
  upgraded: boolean;
  message: string;
};

function roleToSalesTier(role: Role): SalesTier | null {
  if (role === Role.EXECUTIVE) return SalesTier.EXECUTIVE;
  if (role === Role.MANAGER) return SalesTier.MANAGER;
  if (role === Role.SENIOR_MANAGER) return SalesTier.SENIOR_MANAGER;
  return null;
}

function salesTierToRole(tier: SalesTier): SalesMemberRole {
  if (tier === SalesTier.MANAGER) return Role.MANAGER;
  if (tier === SalesTier.SENIOR_MANAGER) return Role.SENIOR_MANAGER;
  return Role.EXECUTIVE;
}

function nextSalesTier(current: SalesTier): SalesTier | null {
  const idx = TIER_ORDER.indexOf(current);
  if (idx < 0 || idx >= TIER_ORDER.length - 1) return null;
  return TIER_ORDER[idx + 1] ?? null;
}

export type PartnerTierInfo = {
  currentRole: Role;
  activeDirectReferrals: number;
  nextTier: SalesTier | null;
  nextTierMinReferrals: number | null;
  tiers: PublicTierConfigDto[];
};

/** Partner dashboard: current tier progress + public tier configuration. */
export async function getPartnerTierInfo(
  prisma: PrismaClient,
  userId: string,
): Promise<PartnerTierInfo | null> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, role: true, status: true },
  });
  if (!user || user.status !== UserStatus.ACTIVE || !isSalesMemberRole(user.role)) {
    return null;
  }

  const tiers = await listPublicTierConfigs(prisma);
  const activeDirectReferrals = await countActiveDirectReferrals(prisma, userId);

  const currentTier = roleToSalesTier(user.role);
  const nextTier = currentTier ? nextSalesTier(currentTier) : null;
  const nextConfig = nextTier
    ? tiers.find((t) => t.tierLevel === nextTier)
    : undefined;

  return {
    currentRole: user.role,
    activeDirectReferrals,
    nextTier,
    nextTierMinReferrals: nextConfig?.minReferralsRequired ?? null,
    tiers,
  };
}

/** Active traders directly acquired by the sponsor (`User.acquiredById`). */
export async function countActiveDirectReferrals(
  prisma: PrismaClient,
  sponsorId: string,
): Promise<number> {
  return prisma.user.count({
    where: {
      acquiredById: sponsorId,
      status: UserStatus.ACTIVE,
      subscriptions: {
        some: {
          status: SubscriptionStatus.ACTIVE,
          isActive: true,
        },
      },
    },
  });
}

async function loadTierConfigMap(
  prisma: PrismaClient,
): Promise<Map<SalesTier, { minReferralsRequired: number }>> {
  const rows = await prisma.tierConfig.findMany({
    select: { tierLevel: true, minReferralsRequired: true },
  });
  const map = new Map<SalesTier, { minReferralsRequired: number }>();
  for (const row of rows) {
    map.set(row.tierLevel, { minReferralsRequired: row.minReferralsRequired });
  }
  return map;
}

async function resolveParentForPromotion(
  prisma: PrismaClient,
  userId: string,
  newRole: SalesMemberRole,
): Promise<{ id: string; role: Role } | null> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      parentId: true,
      parent: { select: { id: true, role: true, parentId: true } },
    },
  });
  if (!user) return null;

  if (newRole === Role.SENIOR_MANAGER) {
    if (!user.parent) return null;
    if (user.parent.role === Role.SENIOR_MANAGER) {
      return { id: user.parent.id, role: user.parent.role };
    }
    if (user.parent.parentId) {
      const grand = await prisma.user.findUnique({
        where: { id: user.parent.parentId },
        select: { id: true, role: true },
      });
      if (grand?.role === Role.SENIOR_MANAGER) {
        return { id: grand.id, role: grand.role };
      }
    }
    return null;
  }

  if (newRole === Role.MANAGER) {
    if (user.parent?.role === Role.SENIOR_MANAGER) {
      return { id: user.parent.id, role: user.parent.role };
    }
    if (user.parent?.parentId) {
      const grand = await prisma.user.findUnique({
        where: { id: user.parent.parentId },
        select: { id: true, role: true },
      });
      if (grand?.role === Role.SENIOR_MANAGER) {
        return { id: grand.id, role: grand.role };
      }
    }
  }

  return user.parent
    ? { id: user.parent.id, role: user.parent.role }
    : null;
}

async function promoteSalesMemberTier(
  prisma: PrismaClient,
  userId: string,
  newRole: SalesMemberRole,
  performedById: string,
): Promise<{ ok: true; newRole: SalesMemberRole } | { ok: false; error: string }> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      role: true,
      parentId: true,
      affiliateProfile: { select: { status: true } },
    },
  });

  if (!user || !isSalesMemberRole(user.role)) {
    return { ok: false, error: "User is not an active sales team member" };
  }
  if (
    !user.affiliateProfile ||
    user.affiliateProfile.status !== AffiliateProfileStatus.ACTIVE
  ) {
    return { ok: false, error: "Partner profile is not active" };
  }

  const parent = await resolveParentForPromotion(prisma, userId, newRole);
  const parentError = validateParentForSalesRole(newRole, parent);
  if (parentError) {
    return { ok: false, error: parentError };
  }

  const nextParentId =
    newRole === Role.SENIOR_MANAGER
      ? user.parentId
      : parent?.role === Role.SENIOR_MANAGER
        ? parent.id
        : user.parentId;

  await prisma.$transaction(async (tx) => {
    await tx.user.update({
      where: { id: userId },
      data: {
        role: newRole,
        parentId: nextParentId ?? null,
      },
    });
    await tx.affiliateProfile.update({
      where: { userId },
      data: {
        upgradedById: performedById,
        upgradedAt: new Date(),
      },
    });
  });

  return { ok: true, newRole };
}

/**
 * Evaluate whether a sponsor qualifies for the next tier and upgrade automatically.
 * Uses `User.acquiredById` as the direct-referral link and `TierConfig.minReferralsRequired`.
 */
export async function evaluateAndUpgradeTier(
  prisma: PrismaClient,
  sponsorId: string,
  options?: { performedById?: string },
): Promise<TierUpgradeEvaluation> {
  const performedById = options?.performedById ?? sponsorId;

  const sponsor = await prisma.user.findUnique({
    where: { id: sponsorId },
    select: { id: true, role: true, status: true },
  });

  if (!sponsor) {
    return {
      sponsorId,
      previousRole: Role.USER,
      newRole: null,
      directActiveReferrals: 0,
      requiredForNextTier: null,
      upgraded: false,
      message: "Sponsor not found",
    };
  }

  if (sponsor.status !== UserStatus.ACTIVE) {
    return {
      sponsorId,
      previousRole: sponsor.role,
      newRole: null,
      directActiveReferrals: 0,
      requiredForNextTier: null,
      upgraded: false,
      message: "Sponsor account is not active",
    };
  }

  const currentTier = roleToSalesTier(sponsor.role);
  if (!currentTier) {
    return {
      sponsorId,
      previousRole: sponsor.role,
      newRole: null,
      directActiveReferrals: 0,
      requiredForNextTier: null,
      upgraded: false,
      message: "User is not on a promotable sales tier",
    };
  }

  const targetTier = nextSalesTier(currentTier);
  if (!targetTier) {
    return {
      sponsorId,
      previousRole: sponsor.role,
      newRole: null,
      directActiveReferrals: await countActiveDirectReferrals(prisma, sponsorId),
      requiredForNextTier: null,
      upgraded: false,
      message: "Already at highest tier",
    };
  }

  const tierConfigs = await loadTierConfigMap(prisma);
  const targetConfig = tierConfigs.get(targetTier);
  const required = targetConfig?.minReferralsRequired ?? 10;
  const directActiveReferrals = await countActiveDirectReferrals(
    prisma,
    sponsorId,
  );

  if (directActiveReferrals < required) {
    return {
      sponsorId,
      previousRole: sponsor.role,
      newRole: null,
      directActiveReferrals,
      requiredForNextTier: required,
      upgraded: false,
      message: `Needs ${required} active direct referrals (has ${directActiveReferrals})`,
    };
  }

  const newRole = salesTierToRole(targetTier);
  const promotion = await promoteSalesMemberTier(
    prisma,
    sponsorId,
    newRole,
    performedById,
  );

  if (!promotion.ok) {
    return {
      sponsorId,
      previousRole: sponsor.role,
      newRole: null,
      directActiveReferrals,
      requiredForNextTier: required,
      upgraded: false,
      message: promotion.error,
    };
  }

  console.log(
    `[affiliate-upgrade] auto-promoted userId=${sponsorId} ` +
      `${sponsor.role} → ${promotion.newRole} ` +
      `(referrals=${directActiveReferrals}/${required})`,
  );

  return {
    sponsorId,
    previousRole: sponsor.role,
    newRole: promotion.newRole,
    directActiveReferrals,
    requiredForNextTier: required,
    upgraded: true,
    message: `Promoted to ${promotion.newRole}`,
  };
}
