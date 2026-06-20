/** Sales / partner roles from Phase 1 Prisma `Role` enum. */
export const SALES_TEAM_ROLES = [
  "EXECUTIVE",
  "MANAGER",
  "SENIOR_MANAGER",
] as const;

export type SalesTeamRole = (typeof SALES_TEAM_ROLES)[number];

/** Normalize API / JWT role strings for comparisons. */
export function normalizeUserRole(role: string | null | undefined): string {
  const r = (role ?? "").trim().toUpperCase();
  if (r === "DIRECTOR" || r === "TEAM_DIRECTOR") return "SENIOR_MANAGER";
  return r;
}

export function isSalesTeamMember(
  role: string | null | undefined,
): role is SalesTeamRole {
  const r = normalizeUserRole(role);
  return r === "EXECUTIVE" || r === "MANAGER" || r === "SENIOR_MANAGER";
}

/** Senior Managers and Managers may submit team-member nominations. */
export function canNominateMembers(role: string | null | undefined): boolean {
  const r = normalizeUserRole(role);
  return r === "SENIOR_MANAGER" || r === "MANAGER";
}

export const SALES_TEAM_ROLE_LABELS: Record<SalesTeamRole, string> = {
  EXECUTIVE: "Team Executive",
  MANAGER: "Team Manager",
  SENIOR_MANAGER: "Senior Manager",
};

/** Accept legacy JWT/API role until tokens refresh after deploy. */
export function normalizeSalesTeamRole(
  role: string | null | undefined,
): SalesTeamRole | null {
  const r = normalizeUserRole(role);
  if (isSalesTeamMember(r)) return r;
  return null;
}
