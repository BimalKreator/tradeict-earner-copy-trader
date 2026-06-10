import {
  AffiliateProfileStatus,
  Role,
  type PrismaClient,
} from "@prisma/client";
import { SALES_MEMBER_ROLES } from "./affiliateMemberService.js";
import { fetchDeltaBalancesForUserIds } from "./dashboardMetricsService.js";

export type NetworkNodeType = "member" | "acquired";

export type AdminNetworkTreeNode = {
  id: string;
  name: string | null;
  email: string;
  role: Role;
  nodeType: NetworkNodeType;
  parentId: string | null;
  acquiredById: string | null;
  directAcquiredCount: number;
  networkAum: number;
  affiliateStatus: AffiliateProfileStatus | null;
  children: AdminNetworkTreeNode[];
};

export type AdminNetworkTreeResponse = {
  tree: AdminNetworkTreeNode[];
  flat: Omit<AdminNetworkTreeNode, "children">[];
  stats: {
    totalMembers: number;
    totalAcquired: number;
    totalNetworkAum: number;
  };
};

const ROLE_SORT: Record<string, number> = {
  DIRECTOR: 0,
  MANAGER: 1,
  EXECUTIVE: 2,
  USER: 3,
  ADMIN: 4,
};

function sortNodes(a: AdminNetworkTreeNode, b: AdminNetworkTreeNode): number {
  const roleDiff =
    (ROLE_SORT[a.role] ?? 99) - (ROLE_SORT[b.role] ?? 99);
  if (roleDiff !== 0) return roleDiff;
  if (a.nodeType !== b.nodeType) {
    return a.nodeType === "member" ? -1 : 1;
  }
  const nameA = (a.name ?? a.email).toLowerCase();
  const nameB = (b.name ?? b.email).toLowerCase();
  return nameA.localeCompare(nameB);
}

function flattenTree(
  nodes: AdminNetworkTreeNode[],
  out: Omit<AdminNetworkTreeNode, "children">[] = [],
): Omit<AdminNetworkTreeNode, "children">[] {
  for (const node of nodes) {
    const { children, ...rest } = node;
    out.push(rest);
    flattenTree(children, out);
  }
  return out;
}

export async function buildAdminNetworkTree(
  prisma: PrismaClient,
): Promise<AdminNetworkTreeResponse> {
  const [members, acquiredUsers] = await Promise.all([
    prisma.user.findMany({
      where: {
        OR: [
          { role: { in: [...SALES_MEMBER_ROLES] } },
          { affiliateProfile: { isNot: null } },
        ],
      },
      select: {
        id: true,
        name: true,
        email: true,
        role: true,
        parentId: true,
        affiliateProfile: {
          select: {
            directAcquiredCount: true,
            networkAum: true,
            status: true,
          },
        },
      },
      orderBy: [{ role: "asc" }, { email: "asc" }],
    }),
    prisma.user.findMany({
      where: { acquiredById: { not: null } },
      select: {
        id: true,
        name: true,
        email: true,
        role: true,
        acquiredById: true,
      },
      orderBy: { createdAt: "asc" },
    }),
  ]);

  const acquiredBalances = await fetchDeltaBalancesForUserIds(
    prisma,
    acquiredUsers.map((u) => u.id),
  );

  const memberNodes = new Map<string, AdminNetworkTreeNode>();

  for (const member of members) {
    memberNodes.set(member.id, {
      id: member.id,
      name: member.name,
      email: member.email,
      role: member.role,
      nodeType: "member",
      parentId: member.parentId,
      acquiredById: null,
      directAcquiredCount: member.affiliateProfile?.directAcquiredCount ?? 0,
      networkAum: member.affiliateProfile?.networkAum ?? 0,
      affiliateStatus: member.affiliateProfile?.status ?? null,
      children: [],
    });
  }

  for (const acquired of acquiredUsers) {
    const acquirerId = acquired.acquiredById;
    if (!acquirerId || !memberNodes.has(acquirerId)) continue;

    const balance = acquiredBalances.get(acquired.id);
    memberNodes.get(acquirerId)!.children.push({
      id: acquired.id,
      name: acquired.name,
      email: acquired.email,
      role: acquired.role,
      nodeType: "acquired",
      parentId: null,
      acquiredById: acquirerId,
      directAcquiredCount: 0,
      networkAum:
        balance?.deltaBalance != null && Number.isFinite(balance.deltaBalance)
          ? balance.deltaBalance
          : 0,
      affiliateStatus: null,
      children: [],
    });
  }

  const roots: AdminNetworkTreeNode[] = [];

  for (const node of memberNodes.values()) {
    node.children.sort(sortNodes);

    if (node.parentId && memberNodes.has(node.parentId)) {
      memberNodes.get(node.parentId)!.children.push(node);
    } else {
      roots.push(node);
    }
  }

  roots.sort(sortNodes);

  const flat = flattenTree(roots);
  const totalMembers = flat.filter((n) => n.nodeType === "member").length;
  const totalAcquired = flat.filter((n) => n.nodeType === "acquired").length;
  const totalNetworkAum = flat
    .filter((n) => n.nodeType === "member")
    .reduce((sum, n) => sum + n.networkAum, 0);

  return {
    tree: roots,
    flat,
    stats: {
      totalMembers,
      totalAcquired,
      totalNetworkAum,
    },
  };
}
