/**
 * Encrypt plain-text (or legacy AES) Delta API secrets to AES-256-GCM (`gcm:v1:`).
 *
 * Run from backend/:
 *   npm run db:migrate-api-keys
 *
 * Requires DATABASE_URL and ENCRYPTION_KEY (or PROCESS_ENCRYPTION_KEY) in .env.
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

function hasEncryptionKey(): boolean {
  return Boolean(
    process.env.ENCRYPTION_KEY?.trim() ||
      process.env.PROCESS_ENCRYPTION_KEY?.trim(),
  );
}

/** Returns GCM ciphertext when migration is needed; null if already GCM or empty. */
function migrateSecretField(label: string, stored: string): string | null {
  const trimmed = stored.trim();
  if (!trimmed) return null;
  if (isGcmSecret(trimmed)) {
    return null;
  }

  const plain = decryptDeltaSecretOrPlain(trimmed);
  if (!plain) {
    console.warn(`[migrate-api-keys] skip ${label} — could not read credential`);
    return null;
  }

  return encryptSecretGCM(plain);
}

async function main(): Promise<void> {
  if (!hasEncryptionKey()) {
    console.error(
      "ENCRYPTION_KEY (or PROCESS_ENCRYPTION_KEY) is required in .env",
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

  let secretsMigrated = 0;
  let keysMigrated = 0;
  let rowsUpdated = 0;
  let rowsSkipped = 0;
  let rowsFailed = 0;

  try {
    console.log("[migrate-api-keys] scanning ExchangeAccount rows…");
    const exchangeAccounts = await prisma.exchangeAccount.findMany({
      select: { id: true, userId: true, apiKey: true, apiSecret: true },
    });

    for (const row of exchangeAccounts) {
      const nextSecret = migrateSecretField(
        `ExchangeAccount ${row.id} (user ${row.userId}) apiSecret`,
        row.apiSecret,
      );
      const nextKey = migrateSecretField(
        `ExchangeAccount ${row.id} (user ${row.userId}) apiKey`,
        row.apiKey,
      );

      if (!nextSecret && !nextKey) {
        rowsSkipped += 1;
        continue;
      }

      try {
        await prisma.exchangeAccount.update({
          where: { id: row.id },
          data: {
            ...(nextSecret ? { apiSecret: nextSecret } : {}),
            ...(nextKey ? { apiKey: nextKey } : {}),
          },
        });
        rowsUpdated += 1;
        if (nextSecret) secretsMigrated += 1;
        if (nextKey) keysMigrated += 1;
        console.log(
          `[migrate-api-keys] ExchangeAccount ${row.id}: encrypted` +
            `${nextSecret ? " apiSecret" : ""}` +
            `${nextKey ? " apiKey" : ""}`,
        );
      } catch (err) {
        rowsFailed += 1;
        console.error(
          `[migrate-api-keys] ExchangeAccount ${row.id} update failed:`,
          err instanceof Error ? err.message : err,
        );
      }
    }

    console.log("[migrate-api-keys] scanning DeltaApiKey rows…");
    const deltaApiKeys = await prisma.deltaApiKey.findMany({
      select: { id: true, userId: true, apiKey: true, apiSecret: true },
    });

    for (const row of deltaApiKeys) {
      const nextSecret = migrateSecretField(
        `DeltaApiKey ${row.id} (user ${row.userId}) apiSecret`,
        row.apiSecret,
      );
      const nextKey = migrateSecretField(
        `DeltaApiKey ${row.id} (user ${row.userId}) apiKey`,
        row.apiKey,
      );

      if (!nextSecret && !nextKey) {
        rowsSkipped += 1;
        continue;
      }

      try {
        await prisma.deltaApiKey.update({
          where: { id: row.id },
          data: {
            ...(nextSecret ? { apiSecret: nextSecret } : {}),
            ...(nextKey ? { apiKey: nextKey } : {}),
          },
        });
        rowsUpdated += 1;
        if (nextSecret) secretsMigrated += 1;
        if (nextKey) keysMigrated += 1;
        console.log(
          `[migrate-api-keys] DeltaApiKey ${row.id}: encrypted` +
            `${nextSecret ? " apiSecret" : ""}` +
            `${nextKey ? " apiKey" : ""}`,
        );
      } catch (err) {
        rowsFailed += 1;
        console.error(
          `[migrate-api-keys] DeltaApiKey ${row.id} update failed:`,
          err instanceof Error ? err.message : err,
        );
      }
    }

    console.log(
      "[migrate-api-keys] done — " +
        `apiSecretsMigrated=${secretsMigrated}, ` +
        `apiKeysMigrated=${keysMigrated}, ` +
        `rowsUpdated=${rowsUpdated}, ` +
        `rowsSkipped=${rowsSkipped}, ` +
        `rowsFailed=${rowsFailed} ` +
        `(ExchangeAccount=${exchangeAccounts.length}, DeltaApiKey=${deltaApiKeys.length})`,
    );
  } finally {
    await prisma.$disconnect();
    await pool.end();
  }
}

main().catch((err) => {
  console.error("[migrate-api-keys] fatal:", err);
  process.exit(1);
});
