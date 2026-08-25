/**
 * Seed an ordinary Play Store reviewer demo account (no auth backdoors).
 *
 * Usage (from backend/):
 *   REVIEWER_EMAIL=... REVIEWER_PASSWORD=... npx tsx src/scripts/seedReviewerAccount.ts
 *   npx tsx src/scripts/seedReviewerAccount.ts --email=... --password=...
 *
 * Credentials go into Play Console → App content → App access.
 * Rotate the password or disable the account once the app is published.
 */
import "dotenv/config";
import bcrypt from "bcrypt";
import pg from "pg";
import { PrismaPg } from "@prisma/adapter-pg";
import { Prisma, PrismaClient, Role, SubscriptionStatus } from "@prisma/client";
import {
  getAllowedEmailDomains,
  isEmailDomainAllowed,
  parseAllowedEmailDomains,
} from "../services/settingsService.js";
import { resolveFutureHedgeStrategy } from "../services/futureHedgeService.js";

/** Must match authController.ts BCRYPT_ROUNDS — password path is unchanged. */
const BCRYPT_ROUNDS = 12;

/** Same shape as publicController / signup-facing validation. */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Executive account — must never be reused or modified by this script.
 * tradeictdevelopers@gmail.com (no +review).
 */
const PROTECTED_EMAIL = "tradeictdevelopers@gmail.com";
const PROTECTED_USER_ID = "695f8b44-0af1-4d87-908b-38d9c942745a";

/** Small deployed capital for UI layout (USD). */
const REVIEWER_DEPLOYED_CAPITAL_USD = 100;

function parseArg(flag: string): string | undefined {
  const prefix = `${flag}=`;
  const hit = process.argv.find((a) => a.startsWith(prefix));
  if (hit) return hit.slice(prefix.length);
  const idx = process.argv.indexOf(flag);
  if (idx >= 0 && process.argv[idx + 1]) return process.argv[idx + 1];
  return undefined;
}

function resolveCredentials(): { email: string; password: string } {
  const email = (
    process.env.REVIEWER_EMAIL?.trim() ||
    parseArg("--email")?.trim() ||
    ""
  ).toLowerCase();
  const password =
    process.env.REVIEWER_PASSWORD?.trim() ||
    parseArg("--password")?.trim() ||
    "";

  if (!email || !password) {
    throw new Error(
      "REVIEWER_EMAIL and REVIEWER_PASSWORD are required (env or --email / --password). " +
        "No default credentials — supply them at run time.",
    );
  }
  return { email, password };
}

function assertSafeReviewerEmail(email: string): void {
  if (email === PROTECTED_EMAIL) {
    throw new Error(
      `Refusing to seed protected executive account ${PROTECTED_EMAIL} ` +
        `(user ${PROTECTED_USER_ID}). Use a distinct address (e.g. +review alias).`,
    );
  }
}

function assertEmailFormat(email: string): void {
  if (!EMAIL_RE.test(email)) {
    throw new Error(
      `Email failed app validation (EMAIL_RE): "${email}". ` +
        "Local part may include +, but the address must be local@domain.tld with no spaces.",
    );
  }
}

async function main(): Promise<void> {
  const { email, password } = resolveCredentials();
  assertSafeReviewerEmail(email);
  assertEmailFormat(email);

  if (password.length < 8) {
    throw new Error("REVIEWER_PASSWORD must be at least 8 characters (same rule as signup).");
  }

  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL is not set");
  }

  const pool = new pg.Pool({ connectionString });
  const adapter = new PrismaPg(pool);
  const prisma = new PrismaClient({ adapter });

  try {
    const allowedRaw = await getAllowedEmailDomains(prisma);
    const allowed = parseAllowedEmailDomains(allowedRaw);
    const domainOk = await isEmailDomainAllowed(prisma, email);
    if (!domainOk) {
      throw new Error(
        `Domain not on allowlist for "${email}". Allowed domains: ${allowed.join(", ") || "(none)"}. ` +
          "Login would be rejected by rejectDisallowedEmail — refusing to create an unusable account.",
      );
    }

    const existing = await prisma.user.findUnique({ where: { email } });
    if (existing?.id === PROTECTED_USER_ID) {
      throw new Error(
        `Refusing to modify protected user ${PROTECTED_USER_ID} (${PROTECTED_EMAIL}).`,
      );
    }

    const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);

    const user = await prisma.user.upsert({
      where: { email },
      create: {
        email,
        password: passwordHash,
        name: "Play Store Reviewer",
        mobile: "9999999999",
        role: Role.USER,
        isOtpBypassed: true,
        otpCode: null,
        otpExpiry: null,
        cryptoBalance: 0,
        deltaBalanceDisplayOffset: 0,
        allowSimulation: false,
        cryptoArbitrageEnabled: false,
      },
      update: {
        password: passwordHash,
        isOtpBypassed: true,
        otpCode: null,
        otpExpiry: null,
        role: Role.USER,
        allowSimulation: false,
        cryptoArbitrageEnabled: false,
      },
    });

    if (user.id === PROTECTED_USER_ID) {
      throw new Error(
        `Abort: upsert resolved to protected user ${PROTECTED_USER_ID}.`,
      );
    }

    const strategy = await resolveFutureHedgeStrategy(prisma);
    const baseCapital =
      Number.isFinite(strategy.baseCapital) && strategy.baseCapital > 0
        ? strategy.baseCapital
        : 10;
    const multiplier = Math.max(
      0.05,
      Math.round((REVIEWER_DEPLOYED_CAPITAL_USD / baseCapital) * 100) / 100,
    );

    const subscription = await prisma.userStrategySubscription.upsert({
      where: {
        userId_strategyId: {
          userId: user.id,
          strategyId: strategy.id,
        },
      },
      create: {
        userId: user.id,
        strategyId: strategy.id,
        multiplier,
        isActive: true,
        status: SubscriptionStatus.ACTIVE,
        isStrategyFeePaid: true,
        profitSharePctSnapshot: new Prisma.Decimal(strategy.profitShare ?? 20),
        exchangeAccountId: null,
        botSlaveId: null,
      },
      update: {
        multiplier,
        isActive: true,
        status: SubscriptionStatus.ACTIVE,
        isStrategyFeePaid: true,
        exchangeAccountId: null,
        botSlaveId: null,
      },
    });

    const exchangeCount = await prisma.exchangeAccount.count({
      where: { userId: user.id },
    });
    if (exchangeCount > 0) {
      console.warn(
        `[seedReviewerAccount] WARNING: user already has ${exchangeCount} ExchangeAccount row(s). ` +
          "This script does not create keys; remove them manually if unintended.",
      );
    }

    console.log("Play Store reviewer account ready:");
    console.log(`  user id:         ${user.id}`);
    console.log(`  email:           ${user.email}`);
    console.log(`  subscription id: ${subscription.id}`);
    console.log(
      `  strategy:        ${strategy.title} (${strategy.id}) multiplier=${multiplier} (~$${REVIEWER_DEPLOYED_CAPITAL_USD} deployed)`,
    );
    console.log("  isOtpBypassed=true — skips OTP AFTER a correct password.");
    console.log("  No ExchangeAccount / API keys created.");
  } finally {
    await prisma.$disconnect();
    await pool.end();
  }
}

main().catch((err) => {
  console.error("[seedReviewerAccount] FAILED:", err instanceof Error ? err.message : err);
  process.exit(1);
});
