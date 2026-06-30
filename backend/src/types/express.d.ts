import type { AdminRole } from "@prisma/client";

declare global {
  namespace Express {
    interface AdminContext {
      id: string;
      role: AdminRole;
      email: string;
      name: string | null;
    }

    interface Request {
      /** Set by JWT middleware after verifying Bearer token (`sub` claim). */
      userId?: string;
      /** Set by admin middleware for platform admins (`role === ADMIN`). */
      admin?: AdminContext;
    }
  }
}

export {};
