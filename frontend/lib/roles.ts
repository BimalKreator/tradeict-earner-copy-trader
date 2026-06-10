/** Sales / partner roles from Phase 1 Prisma `Role` enum. */
export const SALES_TEAM_ROLES = [
  "EXECUTIVE",
  "MANAGER",
  "DIRECTOR",
] as const;

export type SalesTeamRole = (typeof SALES_TEAM_ROLES)[number];

export function isSalesTeamMember(
  role: string | null | undefined,
): role is SalesTeamRole {
  return (
    role === "EXECUTIVE" || role === "MANAGER" || role === "DIRECTOR"
  );
}

export const SALES_TEAM_ROLE_LABELS: Record<SalesTeamRole, string> = {
  EXECUTIVE: "Team Executive",
  MANAGER: "Team Manager",
  DIRECTOR: "Team Director",
};
