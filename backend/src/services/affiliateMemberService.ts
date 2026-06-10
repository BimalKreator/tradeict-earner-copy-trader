import { createHash, randomBytes } from "node:crypto";
import {
  AffiliateProfileStatus,
  PayoutRequestStatus,
  Role,
  SubscriptionStatus,
  UserStatus,
  type Prisma,
  type PrismaClient,
} from "@prisma/client";
import { sendWelcomeToTeamMemberEmail } from "./emailService.js";

export const SALES_MEMBER_ROLES = [
  Role.EXECUTIVE,
  Role.MANAGER,
  Role.DIRECTOR,
] as const;

export type SalesMemberRole = (typeof SALES_MEMBER_ROLES)[number];

const ACTIVE_SUBSCRIPTION_ERROR =
  "User must have an active subscription to become a Team Member";

export function isSalesMemberRole(role: Role): role is SalesMemberRole {
  return (
    role === Role.EXECUTIVE ||
    role === Role.MANAGER ||
    role === Role.DIRECTOR
  );
}

function normalizeReferralCodeInput(raw: string): string {
  return raw.trim().toUpperCase();
}

/**
 * Resolve a public referral code to the affiliate's user id (signup acquisition).
 * Returns null when code is missing, unknown, inactive affiliate, or self-referral.
 */
export async function resolveAffiliateUserIdByReferralCode(
  prisma: PrismaClient,
  referralCode: string | null | undefined,
  signupEmail?: string,
): Promise<string | null> {
  const code = referralCode?.trim();
  if (!code) return null;

  const normalized = normalizeReferralCodeInput(code);
  const profile = await prisma.affiliateProfile.findFirst({
    where: {
      OR: [{ referralCode: code }, { referralCode: normalized }],
      status: AffiliateProfileStatus.ACTIVE,
    },
    select: {
      userId: true,
      user: { select: { email: true, status: true, role: true } },
    },
  });

  if (
    !profile ||
    profile.user.status !== UserStatus.ACTIVE ||
    !isSalesMemberRole(profile.user.role)
  ) {
    return null;
  }

  const emailNorm = signupEmail?.trim().toLowerCase();
  if (emailNorm && profile.user.email.toLowerCase() === emailNorm) {
    return null;
  }

  return profile.userId;
}

/** Bump direct acquisition counter after a referred user signs up. */
export async function incrementAffiliateDirectAcquiredCount(
  tx: Prisma.TransactionClient,
  affiliateUserId: string,
): Promise<void> {
  await tx.affiliateProfile.update({
    where: { userId: affiliateUserId },
    data: { directAcquiredCount: { increment: 1 } },
  });
}

/** At least one active deployed copy subscription (includes 100% coupon activations). */
export async function userHasActivePaidStrategySubscription(
  prisma: PrismaClient,
  userId: string,
): Promise<boolean> {
  const activeSub = await prisma.userStrategySubscription.findFirst({
    where: {
      userId,
      isActive: true,
      status: SubscriptionStatus.ACTIVE,
    },
    select: { id: true },
  });
  return activeSub != null;
}

export function validateParentForSalesRole(
  newRole: SalesMemberRole,
  parent: { id: string; role: Role } | null,
): string | null {
  // Directors sit at the top of the tree — upline is fully optional.
  if (newRole === Role.DIRECTOR) {
    if (!parent) {
      return null;
    }
    if (parent.role !== Role.DIRECTOR) {
      return "A Director's upline must be another Director";
    }
    return null;
  }

  if (!parent) {
    return newRole === Role.EXECUTIVE
      ? "An Executive must be assigned to a Manager or Director"
      : "A Manager must be assigned to a Director";
  }

  if (newRole === Role.EXECUTIVE) {
    if (parent.role !== Role.MANAGER && parent.role !== Role.DIRECTOR) {
      return "An Executive's upline must be a Manager or Director";
    }
    return null;
  }

  if (newRole === Role.MANAGER && parent.role !== Role.DIRECTOR) {
    return "A Manager's upline must be a Director";
  }

  return null;
}

function referralCodeBase(email: string): string {
  const local = email.split("@")[0] ?? "MEMBER";
  const cleaned = local.replace(/[^a-zA-Z0-9]/g, "").toUpperCase();
  return (cleaned || "MEMBER").slice(0, 8);
}

export async function generateUniqueReferralCode(
  prisma: PrismaClient,
  userId: string,
  email: string,
): Promise<string> {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const nonce = randomBytes(3).toString("hex").toUpperCase();
    const code = `TICT-${referralCodeBase(email)}-${nonce}`;
    const hit = await prisma.affiliateProfile.findUnique({
      where: { referralCode: code },
      select: { id: true },
    });
    if (!hit) return code;
  }

  const fallback = createHash("md5")
    .update(`${userId}:${Date.now()}`)
    .digest("hex")
    .slice(0, 10)
    .toUpperCase();
  return `TICT-${fallback}`;
}

const memberUserSelect = {
  id: true,
  name: true,
  email: true,
  role: true,
  parentId: true,
  parent: {
    select: {
      id: true,
      name: true,
      email: true,
      role: true,
    },
  },
  affiliateProfile: {
    select: {
      referralCode: true,
      directAcquiredCount: true,
      networkAum: true,
      status: true,
      upgradedAt: true,
      upgradedById: true,
    },
  },
} as const;

export type AdminMemberRow = {
  id: string;
  name: string | null;
  email: string;
  role: Role;
  parentId: string | null;
  parent: {
    id: string;
    name: string | null;
    email: string;
    role: Role;
  } | null;
  affiliateProfile: {
    referralCode: string;
    directAcquiredCount: number;
    networkAum: number;
    status: AffiliateProfileStatus;
    upgradedAt: Date;
    upgradedById: string | null;
  } | null;
};

export async function listSalesMembers(
  prisma: PrismaClient,
): Promise<AdminMemberRow[]> {
  return prisma.user.findMany({
    where: { role: { in: [...SALES_MEMBER_ROLES] } },
    select: memberUserSelect,
    orderBy: [{ role: "asc" }, { email: "asc" }],
  });
}

export type UpgradeMemberArgs = {
  userId: string;
  newRole: SalesMemberRole;
  parentId?: string | null;
  adminUserId: string;
};

export type UpgradeMemberResult =
  | { ok: true; member: AdminMemberRow }
  | { ok: false; status: number; error: string };

export async function upgradeUserToSalesMember(
  prisma: PrismaClient,
  args: UpgradeMemberArgs,
): Promise<UpgradeMemberResult> {
  const { userId, newRole, adminUserId } = args;
  const parentId =
    args.parentId === undefined || args.parentId === ""
      ? null
      : String(args.parentId).trim();

  const target = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, email: true, name: true, role: true },
  });
  if (!target) {
    return { ok: false, status: 404, error: "User not found" };
  }
  if (target.role === Role.ADMIN) {
    return { ok: false, status: 400, error: "Admin accounts cannot become team members" };
  }

  const hasActivePaid = await userHasActivePaidStrategySubscription(
    prisma,
    userId,
  );
  if (!hasActivePaid) {
    return { ok: false, status: 400, error: ACTIVE_SUBSCRIPTION_ERROR };
  }

  let parent: { id: string; role: Role } | null = null;
  if (parentId) {
    if (parentId === userId) {
      return { ok: false, status: 400, error: "A user cannot be their own upline" };
    }
    parent = await prisma.user.findUnique({
      where: { id: parentId },
      select: { id: true, role: true },
    });
    if (!parent) {
      return { ok: false, status: 400, error: "Selected upline (parent) was not found" };
    }
    if (!isSalesMemberRole(parent.role)) {
      return {
        ok: false,
        status: 400,
        error: "Upline must be an existing team member (Executive, Manager, or Director)",
      };
    }
  }

  const parentError = validateParentForSalesRole(newRole, parent);
  if (parentError) {
    return { ok: false, status: 400, error: parentError };
  }

  const referralCode = await generateUniqueReferralCode(
    prisma,
    userId,
    target.email,
  );

  await prisma.$transaction(async (tx) => {
    await tx.user.update({
      where: { id: userId },
      data: {
        role: newRole,
        parentId,
      },
    });

    await tx.affiliateProfile.upsert({
      where: { userId },
      create: {
        userId,
        referralCode,
        status: AffiliateProfileStatus.ACTIVE,
        upgradedById: adminUserId,
        upgradedAt: new Date(),
      },
      update: {
        status: AffiliateProfileStatus.ACTIVE,
        upgradedById: adminUserId,
        upgradedAt: new Date(),
      },
    });
  });

  const member = await prisma.user.findUnique({
    where: { id: userId },
    select: memberUserSelect,
  });
  if (!member) {
    return { ok: false, status: 500, error: "Upgrade succeeded but member could not be loaded" };
  }

  const referralForEmail =
    member.affiliateProfile?.referralCode ?? referralCode;
  void sendWelcomeToTeamMemberEmail(
    target.email,
    target.name?.trim() || target.email,
    newRole,
    referralForEmail,
  ).catch((err) => {
    console.error(
      `[affiliate] welcome email failed userId=${userId}:`,
      err instanceof Error ? err.message : err,
    );
  });

  return { ok: true, member };
}

/**
 * When a team member is downgraded to USER, suspend (never delete) their affiliate profile.
 */
export async function syncAffiliateProfileOnRoleChange(
  prisma: PrismaClient,
  userId: string,
  previousRole: Role,
  newRole: Role,
): Promise<void> {
  const wasSales = isSalesMemberRole(previousRole);
  const isSales = isSalesMemberRole(newRole);

  if (wasSales && !isSales) {
    await prisma.affiliateProfile.updateMany({
      where: { userId },
      data: { status: AffiliateProfileStatus.SUSPENDED },
    });
    return;
  }

  if (isSales) {
    await prisma.affiliateProfile.updateMany({
      where: { userId },
      data: { status: AffiliateProfileStatus.ACTIVE },
    });
  }
}

export type UserDeletionBlockReason = {
  ok: false;
  status: number;
  message: string;
};

export type UserDeletionCheck =
  | { ok: true }
  | UserDeletionBlockReason;

/**
 * Block deletes that would orphan downline members or destroy commission history.
 */
export async function assertUserSafeToDelete(
  prisma: PrismaClient,
  userId: string,
): Promise<UserDeletionCheck> {
  const [
    asBeneficiary,
    asSource,
    pendingPayouts,
    downlineMembers,
    acquiredUsers,
  ] = await Promise.all([
    prisma.commissionLedger.count({ where: { beneficiaryUserId: userId } }),
    prisma.commissionLedger.count({ where: { sourceUserId: userId } }),
    prisma.payoutRequest.count({
      where: { userId, status: PayoutRequestStatus.PENDING },
    }),
    prisma.user.count({
      where: {
        parentId: userId,
        role: { in: [...SALES_MEMBER_ROLES] },
      },
    }),
    prisma.user.count({ where: { acquiredById: userId } }),
  ]);

  if (asBeneficiary > 0 || asSource > 0) {
    return {
      ok: false,
      status: 409,
      message:
        "User has commission ledger history. Suspend the account instead of deleting.",
    };
  }

  if (pendingPayouts > 0) {
    return {
      ok: false,
      status: 409,
      message: "User has a pending partner payout request.",
    };
  }

  if (downlineMembers > 0) {
    return {
      ok: false,
      status: 409,
      message:
        "User has active team members in their downline. Reassign or downgrade them first.",
    };
  }

  if (acquiredUsers > 0) {
    return {
      ok: false,
      status: 409,
      message:
        "User has acquired referrals. Suspend the partner profile instead of deleting.",
    };
  }

  return { ok: true };
}
