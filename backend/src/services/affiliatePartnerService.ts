import {
  CommissionLedgerStatus,
  InvoiceStatus,
  Role,
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

export type PartnerNetworkUserFinancials = {
  totalProfitGenerated: number;
  totalRevenueShareDue: number;
  totalRevenuePaid: number;
  memberCommissionEarned: number;
  memberCommissionPayable: number;
};

export type PartnerNetworkNode = {
  id: string;
  name: string | null;
  email: string;
  role: Role;
  nodeType: "member" | "user";
  depth: number;
  joinedAt: string | null;
  financials: PartnerNetworkUserFinancials | null;
  children: PartnerNetworkNode[];
};

export type PartnerNetworkDetailsResponse = {
  viewerRole: Role;
  tree: PartnerNetworkNode[];
  stats: {
    totalTeamMembers: number;
    totalUsers: number;
    totalProfitGenerated: number;
    totalRevenueShareDue: number;
    totalRevenuePaid: number;
    totalMemberCommissionEarned: number;
    totalMemberCommissionPayable: number;
  };
};

type MemberRow = {
  id: string;
  name: string | null;
  email: string;
  role: Role;
  parentId: string | null;
};

type AcquiredUserRow = {
  id: string;
  name: string | null;
  email: string;
  role: Role;
  acquiredById: string | null;
  createdAt: Date;
};

const EMPTY_USER_FINANCIALS: PartnerNetworkUserFinancials = {
  totalProfitGenerated: 0,
  totalRevenueShareDue: 0,
  totalRevenuePaid: 0,
  memberCommissionEarned: 0,
  memberCommissionPayable: 0,
};

function emptyUserFinancials(): PartnerNetworkUserFinancials {
  return { ...EMPTY_USER_FINANCIALS };
}

function sumUserFinancials(
  a: PartnerNetworkUserFinancials,
  b: PartnerNetworkUserFinancials,
): PartnerNetworkUserFinancials {
  return {
    totalProfitGenerated: a.totalProfitGenerated + b.totalProfitGenerated,
    totalRevenueShareDue: a.totalRevenueShareDue + b.totalRevenueShareDue,
    totalRevenuePaid: a.totalRevenuePaid + b.totalRevenuePaid,
    memberCommissionEarned:
      a.memberCommissionEarned + b.memberCommissionEarned,
    memberCommissionPayable:
      a.memberCommissionPayable + b.memberCommissionPayable,
  };
}

async function loadUserFinancialMaps(
  prisma: PrismaClient,
  userIds: string[],
  beneficiaryUserId: string,
): Promise<Map<string, PartnerNetworkUserFinancials>> {
  const map = new Map<string, PartnerNetworkUserFinancials>();
  if (userIds.length === 0) return map;

  for (const id of userIds) {
    map.set(id, emptyUserFinancials());
  }

  const [pnlGroups, invoiceDueGroups, invoicePaidGroups, commissionGroups] =
    await Promise.all([
      prisma.pnLRecord.groupBy({
        by: ["userId"],
        where: { userId: { in: userIds }, profitAmount: { gt: 0 } },
        _sum: { profitAmount: true, commissionAmount: true },
      }),
      prisma.invoice.groupBy({
        by: ["userId"],
        where: { userId: { in: userIds } },
        _sum: { amountDue: true },
      }),
      prisma.invoice.groupBy({
        by: ["userId"],
        where: { userId: { in: userIds }, status: InvoiceStatus.PAID },
        _sum: { amountDue: true },
      }),
      prisma.commissionLedger.groupBy({
        by: ["sourceUserId", "status"],
        where: {
          beneficiaryUserId,
          sourceUserId: { in: userIds },
        },
        _sum: { amount: true },
      }),
    ]);

  for (const row of pnlGroups) {
    const fin = map.get(row.userId)!;
    fin.totalProfitGenerated = row._sum.profitAmount ?? 0;
    fin.totalRevenueShareDue = row._sum.commissionAmount ?? 0;
  }

  for (const row of invoiceDueGroups) {
    const fin = map.get(row.userId)!;
    if (fin.totalRevenueShareDue <= 0) {
      fin.totalRevenueShareDue = row._sum.amountDue ?? 0;
    }
  }

  for (const row of invoicePaidGroups) {
    const fin = map.get(row.userId)!;
    fin.totalRevenuePaid = row._sum.amountDue ?? 0;
  }

  for (const row of commissionGroups) {
    const fin = map.get(row.sourceUserId)!;
    const amount = row._sum.amount ?? 0;
    if (row.status === CommissionLedgerStatus.EARNED) {
      fin.memberCommissionEarned += amount;
    } else if (
      row.status === CommissionLedgerStatus.PAYABLE ||
      row.status === CommissionLedgerStatus.WITHDRAWABLE
    ) {
      fin.memberCommissionPayable += amount;
    }
  }

  return map;
}

function toUserNode(
  user: AcquiredUserRow,
  depth: number,
  financials: PartnerNetworkUserFinancials,
): PartnerNetworkNode {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.role,
    nodeType: "user",
    depth,
    joinedAt: user.createdAt.toISOString(),
    financials,
    children: [],
  };
}

function toMemberNode(
  member: MemberRow,
  depth: number,
  children: PartnerNetworkNode[],
): PartnerNetworkNode {
  return {
    id: member.id,
    name: member.name,
    email: member.email,
    role: member.role,
    nodeType: "member",
    depth,
    joinedAt: null,
    financials: null,
    children,
  };
}

function sortNetworkNodes(a: PartnerNetworkNode, b: PartnerNetworkNode): number {
  if (a.nodeType !== b.nodeType) {
    return a.nodeType === "member" ? -1 : 1;
  }
  const roleOrder: Record<string, number> = {
    DIRECTOR: 0,
    MANAGER: 1,
    EXECUTIVE: 2,
    USER: 3,
  };
  const roleDiff = (roleOrder[a.role] ?? 99) - (roleOrder[b.role] ?? 99);
  if (roleDiff !== 0) return roleDiff;
  const nameA = (a.name ?? a.email).toLowerCase();
  const nameB = (b.name ?? b.email).toLowerCase();
  return nameA.localeCompare(nameB);
}

function sortTreeRecursive(nodes: PartnerNetworkNode[]): void {
  nodes.sort(sortNetworkNodes);
  for (const node of nodes) {
    sortTreeRecursive(node.children);
  }
}

async function collectPartnerDownline(
  prisma: PrismaClient,
  viewerId: string,
  viewerRole: Role,
): Promise<{
  members: MemberRow[];
  users: AcquiredUserRow[];
}> {
  if (viewerRole === Role.EXECUTIVE) {
    const users = await prisma.user.findMany({
      where: { role: Role.USER, acquiredById: viewerId },
      select: {
        id: true,
        name: true,
        email: true,
        role: true,
        acquiredById: true,
        createdAt: true,
      },
      orderBy: { createdAt: "desc" },
    });
    return { members: [], users };
  }

  if (viewerRole === Role.MANAGER) {
    const executives = await prisma.user.findMany({
      where: { role: Role.EXECUTIVE, parentId: viewerId },
      select: {
        id: true,
        name: true,
        email: true,
        role: true,
        parentId: true,
      },
      orderBy: { email: "asc" },
    });
    const salesMemberIds = [viewerId, ...executives.map((e) => e.id)];
    const users = await prisma.user.findMany({
      where: { role: Role.USER, acquiredById: { in: salesMemberIds } },
      select: {
        id: true,
        name: true,
        email: true,
        role: true,
        acquiredById: true,
        createdAt: true,
      },
      orderBy: { createdAt: "desc" },
    });
    return { members: executives, users };
  }

  if (viewerRole === Role.DIRECTOR) {
    const managers = await prisma.user.findMany({
      where: { role: Role.MANAGER, parentId: viewerId },
      select: {
        id: true,
        name: true,
        email: true,
        role: true,
        parentId: true,
      },
      orderBy: { email: "asc" },
    });
    const managerIds = managers.map((m) => m.id);
    const executives = await prisma.user.findMany({
      where: {
        role: Role.EXECUTIVE,
        OR: [
          { parentId: { in: managerIds } },
          { parentId: viewerId },
        ],
      },
      select: {
        id: true,
        name: true,
        email: true,
        role: true,
        parentId: true,
      },
      orderBy: { email: "asc" },
    });
    const salesMemberIds = [
      viewerId,
      ...managerIds,
      ...executives.map((e) => e.id),
    ];
    const users = await prisma.user.findMany({
      where: { role: Role.USER, acquiredById: { in: salesMemberIds } },
      select: {
        id: true,
        name: true,
        email: true,
        role: true,
        acquiredById: true,
        createdAt: true,
      },
      orderBy: { createdAt: "desc" },
    });
    return { members: [...managers, ...executives], users };
  }

  return { members: [], users: [] };
}

function buildExecutiveSubtree(
  executive: MemberRow,
  users: AcquiredUserRow[],
  financialsByUserId: Map<string, PartnerNetworkUserFinancials>,
  depth: number,
): PartnerNetworkNode {
  const userChildren = users
    .filter((u) => u.acquiredById === executive.id)
    .map((u) =>
      toUserNode(u, depth + 1, financialsByUserId.get(u.id) ?? emptyUserFinancials()),
    );
  return toMemberNode(executive, depth, userChildren);
}

function buildPartnerNetworkTree(
  viewerId: string,
  viewerRole: Role,
  members: MemberRow[],
  users: AcquiredUserRow[],
  financialsByUserId: Map<string, PartnerNetworkUserFinancials>,
): PartnerNetworkNode[] {
  const tree: PartnerNetworkNode[] = [];

  if (viewerRole === Role.EXECUTIVE) {
    for (const user of users) {
      tree.push(
        toUserNode(
          user,
          0,
          financialsByUserId.get(user.id) ?? emptyUserFinancials(),
        ),
      );
    }
    sortTreeRecursive(tree);
    return tree;
  }

  if (viewerRole === Role.MANAGER) {
    const executives = members.filter((m) => m.role === Role.EXECUTIVE);
    for (const executive of executives) {
      tree.push(buildExecutiveSubtree(executive, users, financialsByUserId, 0));
    }
    for (const user of users.filter((u) => u.acquiredById === viewerId)) {
      tree.push(
        toUserNode(
          user,
          0,
          financialsByUserId.get(user.id) ?? emptyUserFinancials(),
        ),
      );
    }
    sortTreeRecursive(tree);
    return tree;
  }

  if (viewerRole === Role.DIRECTOR) {
    const managers = members.filter((m) => m.role === Role.MANAGER);
    const executives = members.filter((m) => m.role === Role.EXECUTIVE);
    const executivesByManager = new Map<string, MemberRow[]>();
    const directExecutives: MemberRow[] = [];

    for (const executive of executives) {
      if (executive.parentId && managers.some((m) => m.id === executive.parentId)) {
        const list = executivesByManager.get(executive.parentId) ?? [];
        list.push(executive);
        executivesByManager.set(executive.parentId, list);
      } else if (executive.parentId === viewerId) {
        directExecutives.push(executive);
      }
    }

    for (const manager of managers) {
      const managerExecutives = executivesByManager.get(manager.id) ?? [];
      const executiveNodes = managerExecutives.map((executive) =>
        buildExecutiveSubtree(executive, users, financialsByUserId, 1),
      );
      const directUsers = users
        .filter((u) => u.acquiredById === manager.id)
        .map((u) =>
          toUserNode(
            u,
            1,
            financialsByUserId.get(u.id) ?? emptyUserFinancials(),
          ),
        );
      tree.push(toMemberNode(manager, 0, [...executiveNodes, ...directUsers]));
    }

    for (const executive of directExecutives) {
      tree.push(buildExecutiveSubtree(executive, users, financialsByUserId, 0));
    }

    for (const user of users.filter((u) => u.acquiredById === viewerId)) {
      tree.push(
        toUserNode(
          user,
          0,
          financialsByUserId.get(user.id) ?? emptyUserFinancials(),
        ),
      );
    }

    sortTreeRecursive(tree);
    return tree;
  }

  return tree;
}

export async function getPartnerNetworkDetails(
  prisma: PrismaClient,
  userId: string,
): Promise<PartnerNetworkDetailsResponse | null> {
  const viewer = await prisma.user.findUnique({
    where: { id: userId },
    select: { role: true },
  });

  if (!viewer || !isSalesMemberRole(viewer.role)) {
    return null;
  }

  const { members, users } = await collectPartnerDownline(
    prisma,
    userId,
    viewer.role,
  );
  const userIds = users.map((u) => u.id);
  const financialsByUserId = await loadUserFinancialMaps(
    prisma,
    userIds,
    userId,
  );

  const tree = buildPartnerNetworkTree(
    userId,
    viewer.role,
    members,
    users,
    financialsByUserId,
  );

  const aggregate = emptyUserFinancials();
  for (const user of users) {
    const fin = financialsByUserId.get(user.id) ?? emptyUserFinancials();
    Object.assign(aggregate, sumUserFinancials(aggregate, fin));
  }

  return {
    viewerRole: viewer.role,
    tree,
    stats: {
      totalTeamMembers: members.length,
      totalUsers: users.length,
      totalProfitGenerated: aggregate.totalProfitGenerated,
      totalRevenueShareDue: aggregate.totalRevenueShareDue,
      totalRevenuePaid: aggregate.totalRevenuePaid,
      totalMemberCommissionEarned: aggregate.memberCommissionEarned,
      totalMemberCommissionPayable: aggregate.memberCommissionPayable,
    },
  };
}
