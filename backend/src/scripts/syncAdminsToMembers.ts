import "dotenv/config";
import pg from "pg";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";
import { ensurePlatformAdminAsSeniorManagerMember } from "../services/affiliateMemberService.js";

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
  let created = 0;
  let updated = 0;
  let unchanged = 0;

  try {
    const admins = await prisma.user.findMany({
      where: { adminRole: { not: null } },
      select: {
        id: true,
        email: true,
        role: true,
        adminRole: true,
      },
      orderBy: { email: "asc" },
    });

    if (admins.length === 0) {
      console.log("No platform admins with adminRole found — nothing to sync.");
      return;
    }

    console.log(`Found ${admins.length} platform admin(s) to sync as Senior Managers.\n`);

    for (const admin of admins) {
      try {
        const result = await ensurePlatformAdminAsSeniorManagerMember(
          prisma,
          admin.id,
          { upgradedById: admin.id, sendWelcomeEmail: false },
        );

        if (!result.ok) {
          failed += 1;
          console.error(`[fail] ${admin.email}: ${result.error}`);
          continue;
        }

        if (result.profileCreated) created += 1;
        if (result.roleUpdated) updated += 1;
        if (!result.profileCreated && !result.roleUpdated) unchanged += 1;

        console.log(
          `[ok] ${admin.email} -> SENIOR_MANAGER + AffiliateProfile ` +
            `(profile=${result.profileCreated ? "created" : "updated"}, ` +
            `role=${result.roleUpdated ? "updated" : "already SENIOR_MANAGER"})`,
        );
      } catch (err) {
        failed += 1;
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[fail] ${admin.email}: ${message}`);
      }
    }

    console.log(
      `\nDone. profilesCreated=${created} rolesUpdated=${updated} unchanged=${unchanged} failed=${failed}`,
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
  console.error(err);
  process.exit(1);
});
