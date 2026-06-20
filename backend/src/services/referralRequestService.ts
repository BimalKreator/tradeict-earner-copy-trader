import {
  AffiliateProfileStatus,
  Prisma,
  ReferralRequestStatus,
  Role,
  type PrismaClient,
} from "@prisma/client";
import {
  changeUserAcquiredBy,
  isSalesMemberRole,
} from "./affiliateMemberService.js";
import { evaluateAndUpgradeTier } from "./affiliateUpgradeService.js";

type ServiceError = { ok: false; status: number; error: string };
type ServiceOk<T> = { ok: true; data: T };

function normalizeEmail(raw: string): string {
  return raw.trim().toLowerCase();
}

function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

export type ReferralRequestRow = {
  id: string;
  referredEmail: string;
  status: ReferralRequestStatus;
  createdAt: string;
  updatedAt: string;
  sponsor: {
    id: string;
    name: string | null;
    email: string;
    role: Role;
    referralCode: string | null;
  };
  referredUser: {
    id: string;
    name: string | null;
    email: string;
    acquiredById: string | null;
  } | null;
};

export async function createReferralRequest(
  prisma: PrismaClient,
  sponsorId: string,
  referredEmailRaw: string,
): Promise<ServiceOk<{ id: string }> | ServiceError> {
  const referredEmail = normalizeEmail(referredEmailRaw);
  if (!referredEmail || !isValidEmail(referredEmail)) {
    return { ok: false, status: 400, error: "A valid referredEmail is required" };
  }

  const sponsor = await prisma.user.findUnique({
    where: { id: sponsorId },
    select: {
      id: true,
      email: true,
      role: true,
      affiliateProfile: { select: { status: true } },
    },
  });

  if (!sponsor) {
    return { ok: false, status: 404, error: "User not found" };
  }
  if (!isSalesMemberRole(sponsor.role)) {
    return {
      ok: false,
      status: 403,
      error: "Only team members can submit referral requests",
    };
  }
  if (
    !sponsor.affiliateProfile ||
    sponsor.affiliateProfile.status !== AffiliateProfileStatus.ACTIVE
  ) {
    return {
      ok: false,
      status: 403,
      error: "Active partner profile required to submit referrals",
    };
  }

  if (sponsor.email.toLowerCase() === referredEmail) {
    return { ok: false, status: 400, error: "You cannot refer your own email" };
  }

  const existingPending = await prisma.referralRequest.findFirst({
    where: {
      referredEmail: { equals: referredEmail, mode: "insensitive" },
      status: ReferralRequestStatus.PENDING,
    },
    select: { id: true, sponsorId: true },
  });
  if (existingPending) {
    const sameSponsor = existingPending.sponsorId === sponsorId;
    return {
      ok: false,
      status: 409,
      error: sameSponsor
        ? "A pending referral request already exists for this email"
        : "This email already has a pending referral request from another sponsor",
    };
  }

  try {
    const row = await prisma.referralRequest.create({
      data: {
        sponsorId,
        referredEmail,
        status: ReferralRequestStatus.PENDING,
      },
      select: { id: true },
    });
    return { ok: true, data: { id: row.id } };
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError) {
      return { ok: false, status: 400, error: "Could not create referral request" };
    }
    throw err;
  }
}

export async function listReferralRequests(
  prisma: PrismaClient,
  filters?: { status?: ReferralRequestStatus },
): Promise<ReferralRequestRow[]> {
  const rows = await prisma.referralRequest.findMany({
    ...(filters?.status != null ? { where: { status: filters.status } } : {}),
    orderBy: [{ status: "asc" }, { createdAt: "desc" }],
    include: {
      sponsor: {
        select: {
          id: true,
          name: true,
          email: true,
          role: true,
          affiliateProfile: { select: { referralCode: true } },
        },
      },
    },
  });

  const emails = [...new Set(rows.map((r) => normalizeEmail(r.referredEmail)))];
  const referredUsers =
    emails.length > 0
      ? await prisma.user.findMany({
          where: {
            OR: emails.map((email) => ({
              email: { equals: email, mode: "insensitive" as const },
            })),
          },
          select: {
            id: true,
            name: true,
            email: true,
            acquiredById: true,
          },
        })
      : [];

  const userByEmail = new Map(
    referredUsers.map((u) => [u.email.toLowerCase(), u]),
  );

  return rows.map((row) => {
    const referredUser = userByEmail.get(normalizeEmail(row.referredEmail)) ?? null;
    return {
      id: row.id,
      referredEmail: row.referredEmail,
      status: row.status,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      sponsor: {
        id: row.sponsor.id,
        name: row.sponsor.name,
        email: row.sponsor.email,
        role: row.sponsor.role,
        referralCode: row.sponsor.affiliateProfile?.referralCode ?? null,
      },
      referredUser: referredUser
        ? {
            id: referredUser.id,
            name: referredUser.name,
            email: referredUser.email,
            acquiredById: referredUser.acquiredById,
          }
        : null,
    };
  });
}

export type SponsorReferralRequestRow = {
  id: string;
  referredEmail: string;
  status: ReferralRequestStatus;
  createdAt: string;
  updatedAt: string;
};

/** Referral submissions for the authenticated sponsor only. */
export async function listReferralRequestsForSponsor(
  prisma: PrismaClient,
  sponsorId: string,
): Promise<SponsorReferralRequestRow[]> {
  const rows = await prisma.referralRequest.findMany({
    where: { sponsorId },
    orderBy: { createdAt: "desc" },
    take: 50,
    select: {
      id: true,
      referredEmail: true,
      status: true,
      createdAt: true,
      updatedAt: true,
    },
  });

  return rows.map((row) => ({
    id: row.id,
    referredEmail: row.referredEmail,
    status: row.status,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }));
}

export type UpdateReferralRequestResult = {
  id: string;
  status: ReferralRequestStatus;
  tierEvaluation: Awaited<ReturnType<typeof evaluateAndUpgradeTier>> | null;
};

export async function updateReferralRequestStatus(
  prisma: PrismaClient,
  requestId: string,
  status: "APPROVED" | "REJECTED",
  adminUserId: string,
): Promise<ServiceOk<UpdateReferralRequestResult> | ServiceError> {
  const row = await prisma.referralRequest.findUnique({
    where: { id: requestId },
    select: {
      id: true,
      status: true,
      referredEmail: true,
      sponsorId: true,
    },
  });

  if (!row) {
    return { ok: false, status: 404, error: "Referral request not found" };
  }
  if (row.status !== ReferralRequestStatus.PENDING) {
    return {
      ok: false,
      status: 409,
      error: "Only pending requests can be updated",
    };
  }

  if (status === "REJECTED") {
    await prisma.referralRequest.update({
      where: { id: requestId },
      data: { status: ReferralRequestStatus.REJECTED },
    });
    return {
      ok: true,
      data: {
        id: requestId,
        status: ReferralRequestStatus.REJECTED,
        tierEvaluation: null,
      },
    };
  }

  const referredUser = await prisma.user.findFirst({
    where: { email: { equals: row.referredEmail, mode: "insensitive" } },
    select: { id: true, acquiredById: true },
  });

  if (referredUser && !referredUser.acquiredById) {
    const link = await changeUserAcquiredBy(
      prisma,
      referredUser.id,
      row.sponsorId,
    );
    if (!link.ok) {
      return { ok: false, status: link.status, error: link.error };
    }
  }

  await prisma.referralRequest.update({
    where: { id: requestId },
    data: { status: ReferralRequestStatus.APPROVED },
  });

  const tierEvaluation = await evaluateAndUpgradeTier(prisma, row.sponsorId, {
    performedById: adminUserId,
  });

  return {
    ok: true,
    data: {
      id: requestId,
      status: ReferralRequestStatus.APPROVED,
      tierEvaluation,
    },
  };
}
