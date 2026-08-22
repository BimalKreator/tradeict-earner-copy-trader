/**
 * One-off: copy DeltaApiKey → ExchangeAccount for users who have keys
 * but no ExchangeAccount (so billing/ledger can see them).
 *
 * Does NOT delete DeltaApiKey rows. Does NOT overwrite existing ExchangeAccounts.
 *
 * Run from backend/:
 *   npx tsx src/scripts/migrateDeltaApiKeysToExchangeAccounts.ts
 *   npx tsx src/scripts/migrateDeltaApiKeysToExchangeAccounts.ts --apply
 *
 * Default is dry-run (print only). Pass --apply to write.
 */
import "dotenv/config";
import pg from "pg";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";

function parseArgs(argv: string[]): { apply: boolean } {
  let apply = false;
  for (const arg of argv) {
    if (arg === "--apply") apply = true;
    else if (arg === "--help" || arg === "-h") {
      console.log(
        "Usage: migrateDeltaApiKeysToExchangeAccounts.ts [--apply]\n" +
          "  (default) dry-run — print planned creates only\n" +
          "  --apply   create missing ExchangeAccount rows from DeltaApiKey",
      );
      process.exit(0);
    }
  }
  return { apply };
}

async function main(): Promise<void> {
  const { apply } = parseArgs(process.argv.slice(2));
  const dryRun = !apply;

  console.log(
    `[migrate-delta-api-keys] mode=${dryRun ? "DRY-RUN" : "APPLY"}`,
  );

  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    console.error("DATABASE_URL is required");
    process.exit(1);
  }

  const pool = new pg.Pool({ connectionString });
  const adapter = new PrismaPg(pool);
  const prisma = new PrismaClient({ adapter });

  try {
    const deltaKeys = await prisma.deltaApiKey.findMany({
      orderBy: { id: "desc" },
      select: {
        id: true,
        userId: true,
        nickname: true,
        apiKey: true,
        apiSecret: true,
        user: { select: { email: true } },
      },
    });

    /** One DeltaApiKey per user (latest by id desc). */
    const latestByUser = new Map<
      string,
      (typeof deltaKeys)[number]
    >();
    for (const row of deltaKeys) {
      if (!latestByUser.has(row.userId)) {
        latestByUser.set(row.userId, row);
      }
    }

    let planned = 0;
    let created = 0;
    let skippedHasExchange = 0;
    let skippedEmptyCreds = 0;

    for (const [userId, keyRow] of latestByUser) {
      const email = keyRow.user.email ?? "(no email)";
      const existing = await prisma.exchangeAccount.findFirst({
        where: { userId },
        select: { id: true, nickname: true },
      });

      if (existing) {
        skippedHasExchange += 1;
        console.log(
          `  SKIP ${email} — already has ExchangeAccount id=${existing.id} (${existing.nickname})`,
        );
        continue;
      }

      if (!keyRow.apiKey?.trim() || !keyRow.apiSecret?.trim()) {
        skippedEmptyCreds += 1;
        console.log(
          `  SKIP ${email} — DeltaApiKey id=${keyRow.id} has empty credentials`,
        );
        continue;
      }

      const nickname =
        keyRow.nickname?.trim() || "Primary (migrated from DeltaApiKey)";

      planned += 1;
      console.log(
        `  ${dryRun ? "WOULD CREATE" : "CREATE"} ${email} ` +
          `nickname=${JSON.stringify(nickname)} from DeltaApiKey id=${keyRow.id}`,
      );

      if (!dryRun) {
        // Copy stored ciphertext as-is (same encryption; do not re-wrap).
        await prisma.exchangeAccount.create({
          data: {
            userId,
            nickname,
            exchange: "Delta",
            apiKey: keyRow.apiKey,
            apiSecret: keyRow.apiSecret,
          },
        });
        created += 1;
      }
    }

    console.log(
      `\n[migrate-delta-api-keys] done mode=${dryRun ? "DRY-RUN" : "APPLY"} ` +
        `candidates=${latestByUser.size} planned=${planned} ` +
        `created=${created} skippedHasExchange=${skippedHasExchange} ` +
        `skippedEmptyCreds=${skippedEmptyCreds}`,
    );
    if (dryRun && planned > 0) {
      console.log("Re-run with --apply to write ExchangeAccount rows.");
    }
  } finally {
    await prisma.$disconnect();
    await pool.end();
  }
}

main().catch((err) => {
  console.error("[migrate-delta-api-keys] fatal:", err);
  process.exit(1);
});
