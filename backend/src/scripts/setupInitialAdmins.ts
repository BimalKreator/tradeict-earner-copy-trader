import "dotenv/config";
import pg from "pg";
import { PrismaPg } from "@prisma/adapter-pg";
import {
  AdminRole,
  Prisma,
  PrismaClient,
  Role,
} from "@prisma/client";

/** Platform admin RBAC assignments (email → adminRole). */
const INITIAL_ADMINS: ReadonlyArray<{
  email: string;
  adminRole: AdminRole;
}> = [
  { email: "bimal.vishwakarma@gmail.com", adminRole: AdminRole.SUPER_ADMIN },
  { email: "jazz5587@gmail.com", adminRole: AdminRole.MANAGER },
  { email: "canshulv143@gmail.com", adminRole: AdminRole.MANAGER },
];

async function main(): Promise<void> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    console.error("DATABASE_URL is required");
    process.exit(1);
  }

  const pool = new pg.Pool({ connectionString });
  const adapter = new PrismaPg(pool);
  const prisma = new PrismaClient({ adapter });

  let failed = 0;

  try {
    for (const { email, adminRole } of INITIAL_ADMINS) {
      const normalizedEmail = email.trim().toLowerCase();

      try {
        const user = await prisma.user.update({
          where: { email: normalizedEmail },
          data: {
            role: Role.ADMIN,
            adminRole,
          },
          select: { id: true, email: true, role: true, adminRole: true },
        });

        console.log(
          `[ok] ${normalizedEmail} -> adminRole=${user.adminRole ?? adminRole} (role=${user.role}, id=${user.id})`,
        );
      } catch (err) {
        failed += 1;
        if (
          err instanceof Prisma.PrismaClientKnownRequestError &&
          err.code === "P2025"
        ) {
          console.error(`[fail] ${normalizedEmail}: no user found with this email`);
        } else {
          const message = err instanceof Error ? err.message : String(err);
          console.error(`[fail] ${normalizedEmail}: ${message}`);
        }
      }
    }

    if (failed > 0) {
      console.error(`\nCompleted with ${failed} failure(s).`);
      process.exit(1);
    }

    console.log(`\nAll ${INITIAL_ADMINS.length} admin role assignment(s) applied.`);
  } finally {
    await prisma.$disconnect();
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
