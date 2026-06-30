import { Role, type AdminRole } from "@prisma/client";

/** Platform panel access: legacy `role === ADMIN` or RBAC `adminRole` set. */
export function isPlatformAdminUser(user: {
  role: Role;
  adminRole?: AdminRole | null;
}): boolean {
  return user.role === Role.ADMIN || user.adminRole != null;
}
