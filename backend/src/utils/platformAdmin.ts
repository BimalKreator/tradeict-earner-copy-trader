import { Role, type AdminRole } from "@prisma/client";

/** Platform panel access: must be ADMIN with an explicit adminRole. */
export function isPlatformAdminUser(user: {
  role: Role;
  adminRole?: AdminRole | null;
}): boolean {
  return user.role === Role.ADMIN && user.adminRole != null;
}
