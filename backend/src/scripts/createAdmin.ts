import "dotenv/config";
import bcrypt from "bcrypt";
import pg from "pg";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient, Role } from "@prisma/client";

const SALT_ROUNDS = 12;

/** Fallback when argv / env are unset — change before production use. */
const HARDCODED_EMAIL = "admin@example.com";
const HARDCODED_PASSWORD = "changeme";
const HARDCODED_NAME = "Administrator";

function resolveArgs(): { email: string; password: string; name: string } {
  const [, , emailArg, passwordArg, nameArg] = process.argv;

  const email =
    emailArg ??
    process.env.SEED_ADMIN_EMAIL ??
    HARDCODED_EMAIL;

  const password =
    passwordArg ??
    process.env.SEED_ADMIN_PASSWORD ??
    HARDCODED_PASSWORD;

  const name =
    nameArg ??
    process.env.SEED_ADMIN_NAME ??
    HARDCODED_NAME;

  return { email, password, name };
}

async function main(): Promise<void> {
  const { email, password, name } = resolveArgs();

  if (!email.trim() || !password) {
    console.error(
      "Usage: npx ts-node src/scripts/createAdmin.ts <email> <password> [name]",
    );
    console.error(
      "Or set SEED_ADMIN_EMAIL, SEED_ADMIN_PASSWORD, SEED_ADMIN_NAME in .env",
    );
    process.exit(1);
  }

  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    console.error("DATABASE_URL is required");
    process.exit(1);
  }

  const pool = new pg.Pool({ connectionString });
  const adapter = new PrismaPg(pool);
  const prisma = new PrismaClient({ adapter });

  try {
    const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);

    const user = await prisma.user.create({
      data: {
        email: email.trim().toLowerCase(),
        password: passwordHash,
        name,
        role: Role.ADMIN,
      },
    });

    console.log(
      `Created ADMIN user id=${user.id} email=${user.email} name=${user.name ?? name}`,
    );
  } finally {
    await prisma.$disconnect();
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
