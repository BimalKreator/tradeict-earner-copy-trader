import {
  CommissionLedgerStatus,
  SubscriptionStatus,
  type PrismaClient,
} from "@prisma/client";
import { isSalesMemberRole } from "./affiliateMemberService.js";
import {
  fetchDeltaBalancesForUserIds,
  strategyShortName,
  sumDeltaBalancesForUserIds,
} from "./dashboardMetricsService.js";

export type PartnerWalletTotals = {
  earned: number;
  payable: number;
  withdrawable: number;
};

export type PartnerMetrics = {
  referralCode: string | null;
  directAcquiredCount: number;
  networkAum: number;
  wallets: PartnerWalletTotals;
};

export type PartnerDirectUserRow = {
  id: string;
  name: string | null;
  email: string;
  joinedAt: string;
  strategyStatus: string;
  currentBalance: number | null;
  deltaConnected: boolean;
};

const COMMISSION_WALLET_STATUSES = [
  CommissionLedgerStatus.EARNED,
  CommissionLedgerStatus.PAYABLE,
  CommissionLedgerStatus.WITHDRAWABLE,
] as const;

function emptyWallets(): PartnerWalletTotals {
  return { earned: 0, payable: 0, withdrawable: 0 };
}

async function sumCommissionWalletsByStatus(
  prisma: PrismaClient,
  beneficiaryUserId: string,
): Promise<PartnerWalletTotals> {
  const groups = await prisma.commissionLedger.groupBy({
    by: ["status"],
    where: {
      beneficiaryUserId,
      status: { in: [...COMMISSION_WALLET_STATUSES] },
    },
    _sum: { amount: true },
  });

  const wallets = emptyWallets();
  for (const row of groups) {
    const amount = row._sum.amount ?? 0;
    if (row.status === CommissionLedgerStatus.EARNED) wallets.earned = amount;
    else if (row.status === CommissionLedgerStatus.PAYABLE) wallets.payable = amount;
    else if (row.status === CommissionLedgerStatus.WITHDRAWABLE) {
      wallets.withdrawable = amount;
    }
  }
  return wallets;
}

function formatStrategyStatus(
  subs: {
    status: SubscriptionStatus;
    strategy: { title: string };
  }[],
): string {
  if (subs.length === 0) return "No subscription";

  const active = subs.filter((s) => s.status === SubscriptionStatus.ACTIVE);
  if (active.length > 0) {
    const names = active.map((s) => strategyShortName(s.strategy.title));
    return `Active · ${names.join(", ")}`;
  }

  const paused = subs.filter(
    (s) => s.status === SubscriptionStatus.PAUSED_DUE_TO_FUNDS,
  );
  if (paused.length > 0) {
    const names = paused.map((s) => strategyShortName(s.strategy.title));
    return `Paused (funds) · ${names.join(", ")}`;
  }

  const cancelled = subs.filter((s) => s.status === SubscriptionStatus.CANCELLED);
  if (cancelled.length > 0) {
    return "Cancelled";
  }

  return subs[0]!.status;
}

export async function getPartnerMetrics(
  prisma: PrismaClient,
  userId: string,
): Promise<PartnerMetrics | null> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      role: true,
      affiliateProfile: {
        select: {
          referralCode: true,
          directAcquiredCount: true,
        },
      },
    },
  });

  if (!user || !isSalesMemberRole(user.role)) {
    return null;
  }

  const acquiredUsers = await prisma.user.findMany({
    where: { acquiredById: userId },
    select: { id: true },
  });
  const acquiredIds = acquiredUsers.map((u) => u.id);

  const [wallets, networkAum] = await Promise.all([
    sumCommissionWalletsByStatus(prisma, userId),
    sumDeltaBalancesForUserIds(prisma, acquiredIds),
  ]);

  return {
    referralCode: user.affiliateProfile?.referralCode ?? null,
    directAcquiredCount:
      user.affiliateProfile?.directAcquiredCount ?? acquiredIds.length,
    networkAum,
    wallets,
  };
}

export async function listPartnerDirectUsers(
  prisma: PrismaClient,
  userId: string,
): Promise<PartnerDirectUserRow[] | null> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { role: true },
  });

  if (!user || !isSalesMemberRole(user.role)) {
    return null;
  }

  const rows = await prisma.user.findMany({
    where: { acquiredById: userId },
    select: {
      id: true,
      name: true,
      email: true,
      createdAt: true,
      subscriptions: {
        select: {
          status: true,
          strategy: { select: { title: true } },
        },
        orderBy: { joinedDate: "desc" },
      },
    },
    orderBy: { createdAt: "desc" },
  });

  const balances = await fetchDeltaBalancesForUserIds(
    prisma,
    rows.map((r) => r.id),
  );

  return rows.map((row) => {
    const balance = balances.get(row.id);
    return {
      id: row.id,
      name: row.name,
      email: row.email,
      joinedAt: row.createdAt.toISOString(),
      strategyStatus: formatStrategyStatus(row.subscriptions),
      currentBalance: balance?.deltaBalance ?? null,
      deltaConnected: balance?.deltaConnected ?? false,
    };
  });
}
