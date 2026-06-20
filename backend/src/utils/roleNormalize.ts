import { Role, SalesTier } from "@prisma/client";

/** Legacy affiliate tier label before Phase 1 rename. */
export const LEGACY_SENIOR_MANAGER_ROLE = "DIRECTOR" as const;

export type SalesMemberRoleInput =
  | typeof Role.EXECUTIVE
  | typeof Role.MANAGER
  | typeof Role.SENIOR_MANAGER;

const SALES_MEMBER_ROLE_SET = new Set<string>([
  Role.EXECUTIVE,
  Role.MANAGER,
  Role.SENIOR_MANAGER,
]);

/** Map legacy `DIRECTOR` (and aliases) to `SENIOR_MANAGER` for API + comparisons. */
export function normalizeAffiliateRole(
  role: string | null | undefined,
): string {
  const r = (role ?? "").trim().toUpperCase();
  if (r === LEGACY_SENIOR_MANAGER_ROLE || r === "TEAM_DIRECTOR") {
    return Role.SENIOR_MANAGER;
  }
  return r;
}

export function normalizeAffiliateRoleEnum(role: string): Role | null {
  const normalized = normalizeAffiliateRole(role);
  if (normalized === Role.ADMIN) return Role.ADMIN;
  if (normalized === Role.USER) return Role.USER;
  if (normalized === Role.EXECUTIVE) return Role.EXECUTIVE;
  if (normalized === Role.MANAGER) return Role.MANAGER;
  if (normalized === Role.SENIOR_MANAGER) return Role.SENIOR_MANAGER;
  return null;
}

export function normalizeSalesTier(
  tier: string | null | undefined,
): string {
  const t = (tier ?? "").trim().toUpperCase();
  if (t === LEGACY_SENIOR_MANAGER_ROLE) return SalesTier.SENIOR_MANAGER;
  return t;
}

export function isNormalizedSalesMemberRole(
  role: string | null | undefined,
): boolean {
  return SALES_MEMBER_ROLE_SET.has(normalizeAffiliateRole(role));
}

/** Accept EXECUTIVE | MANAGER | SENIOR_MANAGER | legacy DIRECTOR for admin/API input. */
export function parseSalesMemberRoleInput(
  raw: string,
): SalesMemberRoleInput | null {
  const normalized = normalizeAffiliateRole(raw);
  if (
    normalized === Role.EXECUTIVE ||
    normalized === Role.MANAGER ||
    normalized === Role.SENIOR_MANAGER
  ) {
    return normalized as SalesMemberRoleInput;
  }
  return null;
}
