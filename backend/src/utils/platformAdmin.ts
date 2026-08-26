import { AdminRole, Role } from "@prisma/client";

/**
 * Platform panel access: ADMIN with SUPER_ADMIN or MANAGER only.
 * SUPPORT (legacy) and unknown roles fail closed — no access.
 */
export function isPlatformAdminUser(user: {
  role: Role;
  adminRole?: AdminRole | null;
}): boolean {
  return (
    user.role === Role.ADMIN &&
    (user.adminRole === AdminRole.SUPER_ADMIN ||
      user.adminRole === AdminRole.MANAGER)
  );
}
