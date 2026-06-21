/**
 * Re-encrypt Delta API credentials from legacy AES-CBC / plaintext to AES-256-GCM.
 *
 * Run from backend/: `npm run build && node dist/scripts/migrate-encryption.js`
 * Requires DATABASE_URL and PROCESS_ENCRYPTION_KEY in .env.
 */
import "dotenv/config";
import pg from "pg";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";
import {
  decryptDeltaSecretOrPlain,
  encryptSecretGCM,
  isGcmSecret,
} from "../utils/encryption.js";

function migrateStoredSecret(label: string, stored: string): string | null {
  const trimmed = stored.trim();
  if (!trimmed) return null;
  if (isGcmSecret(trimmed)) {
    return null;
  }
  const plain = decryptDeltaSecretOrPlain(trimmed);
  if (!plain) {
    console.warn(`[migrate-encryption] skip ${label} — could not read credential`);
    return null;
  }
  return encryptSecretGCM(plain);
}

async function main(): Promise<void> {
  if (!process.env.PROCESS_ENCRYPTION_KEY?.trim()) {
    console.error("PROCESS_ENCRYPTION_KEY is required");
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

  let updated = 0;
  let skipped = 0;

  try {
    const exchangeAccounts = await prisma.exchangeAccount.findMany({
      select: { id: true, apiKey: true, apiSecret: true },
    });
    for (const row of exchangeAccounts) {
      const nextKey = migrateStoredSecret(
        `ExchangeAccount ${row.id} apiKey`,
        row.apiKey,
      );
      const nextSecret = migrateStoredSecret(
        `ExchangeAccount ${row.id} apiSecret`,
        row.apiSecret,
      );
      if (!nextKey && !nextSecret) {
        skipped += 1;
        continue;
      }
      await prisma.exchangeAccount.update({
        where: { id: row.id },
        data: {
          ...(nextKey ? { apiKey: nextKey } : {}),
          ...(nextSecret ? { apiSecret: nextSecret } : {}),
        },
      });
      updated += 1;
    }

    const deltaApiKeys = await prisma.deltaApiKey.findMany({
      select: { id: true, apiKey: true, apiSecret: true },
    });
    for (const row of deltaApiKeys) {
      const nextKey = migrateStoredSecret(
        `DeltaApiKey ${row.id} apiKey`,
        row.apiKey,
      );
      const nextSecret = migrateStoredSecret(
        `DeltaApiKey ${row.id} apiSecret`,
        row.apiSecret,
      );
      if (!nextKey && !nextSecret) {
        skipped += 1;
        continue;
      }
      await prisma.deltaApiKey.update({
        where: { id: row.id },
        data: {
          ...(nextKey ? { apiKey: nextKey } : {}),
          ...(nextSecret ? { apiSecret: nextSecret } : {}),
        },
      });
      updated += 1;
    }

    const strategies = await prisma.strategy.findMany({
      select: { id: true, title: true, masterApiKey: true, masterApiSecret: true },
    });
    for (const row of strategies) {
      const nextKey = migrateStoredSecret(
        `Strategy ${row.id} (${row.title}) masterApiKey`,
        row.masterApiKey,
      );
      const nextSecret = migrateStoredSecret(
        `Strategy ${row.id} (${row.title}) masterApiSecret`,
        row.masterApiSecret,
      );
      if (!nextKey && !nextSecret) {
        skipped += 1;
        continue;
      }
      await prisma.strategy.update({
        where: { id: row.id },
        data: {
          ...(nextKey ? { masterApiKey: nextKey } : {}),
          ...(nextSecret ? { masterApiSecret: nextSecret } : {}),
        },
      });
      updated += 1;
    }

    console.log(
      `[migrate-encryption] done — updated=${updated} skipped=${skipped} ` +
        `(ExchangeAccount=${exchangeAccounts.length}, DeltaApiKey=${deltaApiKeys.length}, Strategy=${strategies.length})`,
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
