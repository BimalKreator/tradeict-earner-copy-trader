/**
 * Assign exact platform RBAC and affiliate (Senior Manager) roles by email.
 *
 * Run from backend/:
 *   npm run set-exact-roles
 *
 * Requires DATABASE_URL in .env.
 */
import "dotenv/config";
import pg from "pg";
import { PrismaPg } from "@prisma/adapter-pg";
import {
  AdminRole,
  Prisma,
  PrismaClient,
  Role,
} from "@prisma/client";
import { ensurePlatformAdminAsSeniorManagerMember } from "../services/affiliateMemberService.js";

type RoleAssignment = {
  email: string;
  adminRole: AdminRole;
  affiliateRole: typeof Role.SENIOR_MANAGER;
};

const ASSIGNMENTS: ReadonlyArray<RoleAssignment> = [
  {
    email: "bimal.vishwakarma@gmail.com",
    adminRole: AdminRole.SUPER_ADMIN,
    affiliateRole: Role.SENIOR_MANAGER,
  },
  {
    email: "canshulv143@gmail.com",
    adminRole: AdminRole.MANAGER,
    affiliateRole: Role.SENIOR_MANAGER,
  },
  {
    email: "jai.kvspl@gmail.com",
    adminRole: AdminRole.MANAGER,
    affiliateRole: Role.SENIOR_MANAGER,
  },
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
  let succeeded = 0;

  try {
    for (const assignment of ASSIGNMENTS) {
      const normalizedEmail = assignment.email.trim().toLowerCase();

      try {
        const user = await prisma.user.update({
          where: { email: normalizedEmail },
          data: {
            role: Role.ADMIN,
            adminRole: assignment.adminRole,
          },
          select: {
            id: true,
            email: true,
            role: true,
            adminRole: true,
          },
        });

        const memberResult = await ensurePlatformAdminAsSeniorManagerMember(
          prisma,
          user.id,
          { upgradedById: user.id, sendWelcomeEmail: false },
        );

        if (!memberResult.ok) {
          failed += 1;
          console.error(
            `[fail] ${normalizedEmail}: platform role set but affiliate sync failed — ${memberResult.error}`,
          );
          continue;
        }

        succeeded += 1;
        console.log(
          `[ok] ${normalizedEmail} -> ` +
            `platform: role=${user.role}, adminRole=${user.adminRole}; ` +
            `affiliate: ${assignment.affiliateRole} ` +
            `(AffiliateProfile ${memberResult.profileCreated ? "created" : "updated"}, ` +
            `user.role ${memberResult.roleUpdated ? "updated" : "unchanged"})`,
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

    console.log(
      `\nDone. succeeded=${succeeded} failed=${failed} total=${ASSIGNMENTS.length}`,
    );

    if (failed > 0) {
      process.exit(1);
    }
  } finally {
    await prisma.$disconnect();
    await pool.end();
  }
}

main().catch((err) => {
  console.error("[set-exact-roles] fatal:", err);
  process.exit(1);
});
