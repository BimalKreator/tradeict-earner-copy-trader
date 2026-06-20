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
  SENIOR_MANAGER: 0,
  MANAGER: 1,
  EXECUTIVE: 2,
  USER: 3,
  ADMIN: 4,
};

function sortNodes(a: AdminNetworkTreeNode, b: AdminNetworkTreeNode): number {
  const roleDiff = (ROLE_SORT[a.role] ?? 99) - (ROLE_SORT[b.role] ?? 99);
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

function sortTreeRecursive(nodes: AdminNetworkTreeNode[]): void {
  nodes.sort(sortNodes);
  for (const node of nodes) {
    sortTreeRecursive(node.children);
  }
}

/**
 * Link sales members by `parentId`. Roots = no upline, missing upline, or self-parent.
 * If every node is nested (cycle), fall back to all members at root level.
 */
function assembleMemberHierarchy(
  memberNodes: Map<string, AdminNetworkTreeNode>,
): AdminNetworkTreeNode[] {
  const attachedAsChild = new Set<string>();

  for (const [memberId, node] of memberNodes) {
    const parentId = node.parentId;
    if (
      parentId &&
      parentId !== memberId &&
      memberNodes.has(parentId)
    ) {
      memberNodes.get(parentId)!.children.push(node);
      attachedAsChild.add(memberId);
    }
  }

  const roots: AdminNetworkTreeNode[] = [];
  for (const [memberId, node] of memberNodes) {
    if (!attachedAsChild.has(memberId)) {
      roots.push(node);
    }
  }

  if (roots.length === 0 && memberNodes.size > 0) {
    return [...memberNodes.values()].sort(sortNodes);
  }

  return roots.sort(sortNodes);
}

/** Alias for admin controller / routes. */
export const getNetworkTree = buildAdminNetworkTree;

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

  let acquiredBalances = new Map<
    string,
    { deltaBalance: number | null; deltaConnected: boolean }
  >();
  try {
    acquiredBalances = await fetchDeltaBalancesForUserIds(
      prisma,
      acquiredUsers.map((u) => u.id),
    );
  } catch (err) {
    console.warn(
      "[network-tree] Delta balance fetch skipped:",
      err instanceof Error ? err.message : err,
    );
  }

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

  const roots = assembleMemberHierarchy(memberNodes);

  for (const acquired of acquiredUsers) {
    const acquirerId = acquired.acquiredById;
    if (!acquirerId) continue;

    const balance = acquiredBalances.get(acquired.id);
    const acquiredNode: AdminNetworkTreeNode = {
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
    };

    const acquirer = memberNodes.get(acquirerId);
    if (acquirer) {
      acquirer.children.push(acquiredNode);
    }
  }

  sortTreeRecursive(roots);

  const flat = flattenTree(roots);
  const totalMembers = members.length;
  const totalAcquired = acquiredUsers.filter((u) =>
    u.acquiredById ? memberNodes.has(u.acquiredById) : false,
  ).length;
  const totalNetworkAum = members.reduce(
    (sum, m) => sum + (m.affiliateProfile?.networkAum ?? 0),
    0,
  );

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
