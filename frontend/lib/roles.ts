/** Sales / partner roles from Phase 1 Prisma `Role` enum. */
export const SALES_TEAM_ROLES = [
  "EXECUTIVE",
  "MANAGER",
  "DIRECTOR",
] as const;

export type SalesTeamRole = (typeof SALES_TEAM_ROLES)[number];

/** Normalize API / JWT role strings for comparisons. */
export function normalizeUserRole(role: string | null | undefined): string {
  return (role ?? "").trim().toUpperCase();
}

export function isSalesTeamMember(
  role: string | null | undefined,
): role is SalesTeamRole {
  const r = normalizeUserRole(role);
  return r === "EXECUTIVE" || r === "MANAGER" || r === "DIRECTOR";
}

/** Directors and Managers may submit team-member nominations. */
export function canNominateMembers(role: string | null | undefined): boolean {
  const r = normalizeUserRole(role);
  return r === "DIRECTOR" || r === "MANAGER";
}

export const SALES_TEAM_ROLE_LABELS: Record<SalesTeamRole, string> = {
  EXECUTIVE: "Team Executive",
  MANAGER: "Team Manager",
  DIRECTOR: "Team Director",
};
