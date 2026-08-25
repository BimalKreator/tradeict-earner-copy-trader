/**
 * Seed an ordinary Play Store reviewer demo account (no auth backdoors).
 *
 * Usage (from backend/):
 *   REVIEWER_EMAIL=... REVIEWER_PASSWORD=... npx tsx src/scripts/seedReviewerAccount.ts
 *   npx tsx src/scripts/seedReviewerAccount.ts --email=... --password=...
 *
 * Never hardcode credentials here — that is what 14.2 removed.
 */
import "dotenv/config";
import bcrypt from "bcrypt";
import pg from "pg";
import { PrismaPg } from "@prisma/adapter-pg";
import {
  Prisma,
  PrismaClient,
  Role,
  SubscriptionStatus,
} from "@prisma/client";
import {
  getAllowedEmailDomains,
  isEmailDomainAllowed,
  parseAllowedEmailDomains,
} from "../services/settingsService.js";
import { resolvePrimaryStrategy } from "../services/futureHedgeService.js";

/** Same rounds as authController.ts — do not import from that file. */
const BCRYPT_ROUNDS = 12;

/** Same shape as publicController / signup-facing email checks. */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const PROTECTED_EXECUTIVE_EMAIL = "tradeictdevelopers@gmail.com";
const PROTECTED_EXECUTIVE_USER_ID = "695f8b44-0af1-4d87-908b-38d9c942745a";

/** Small display capital so strategy UI is populated without real funds. */
const REVIEWER_DEPLOYED_CAPITAL_USD = 10;

function parseArgvFlag(name: string): string | undefined {
  const prefix = `--${name}=`;
  for (const arg of process.argv.slice(2)) {
    if (arg.startsWith(prefix)) return arg.slice(prefix.length);
  }
  const idx = process.argv.indexOf(`--${name}`);
  if (idx >= 0 && process.argv[idx + 1]) return process.argv[idx + 1];
  return undefined;
}

function resolveCredentials(): { email: string; password: string } {
  const email =
    parseArgvFlag("email")?.trim() ||
    process.env.REVIEWER_EMAIL?.trim() ||
    "";
  const password =
    parseArgvFlag("password") || process.env.REVIEWER_PASSWORD || "";
  return { email, password };
}

/** Lowercase + strip Gmail +tag / dots so aliases cannot collide with the executive. */
function gmailCanonicalEmail(email: string): string {
  const normalized = email.trim().toLowerCase();
  const at = normalized.lastIndexOf("@");
  if (at < 0) return normalized;
  const local = normalized.slice(0, at);
  const domain = normalized.slice(at + 1);
  if (domain !== "gmail.com" && domain !== "googlemail.com") {
    return normalized;
  }
  const withoutPlus = local.split("+")[0] ?? local;
  const withoutDots = withoutPlus.replace(/\./g, "");
  return `${withoutDots}@gmail.com`;
}

function validateEmailFormat(email: string): void {
  if (!EMAIL_RE.test(email)) {
    throw new Error(
      `Email failed app validation (EMAIL_RE): "${email}". ` +
        `Expected a simple local@domain form (plus-tags are allowed by this regex).`,
    );
  }
  const parts = email.split("@");
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new Error(`Email failed split/@ validation: "${email}"`);
  }
}

async function main(): Promise<void> {
  const { email: emailRaw, password } = resolveCredentials();
  if (!emailRaw || !password) {
    console.error(
      "Refuse to run: REVIEWER_EMAIL and REVIEWER_PASSWORD are required " +
        "(env or --email / --password). No default credentials.",
    );
    process.exit(1);
  }

  const email = emailRaw.trim().toLowerCase();
  validateEmailFormat(email);

  if (
    email === PROTECTED_EXECUTIVE_EMAIL ||
    gmailCanonicalEmail(email) === PROTECTED_EXECUTIVE_EMAIL
  ) {
    throw new Error(
      `Abort: email normalises to ${PROTECTED_EXECUTIVE_EMAIL} — ` +
        `that is executive user ${PROTECTED_EXECUTIVE_USER_ID}. ` +
        `The reviewer account must use a distinct address (e.g. +review).`,
    );
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
    if (!(await isEmailDomainAllowed(prisma, email))) {
      throw new Error(
        `Abort: domain not on allowlist for "${email}". ` +
          `Allowed domains: ${allowed.join(", ") || "(none)"}`,
      );
    }

    const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);

    const existingByEmail = await prisma.user.findUnique({
      where: { email },
    });
    if (existingByEmail?.id === PROTECTED_EXECUTIVE_USER_ID) {
      throw new Error(
        `Abort: refusing to modify protected executive user ${PROTECTED_EXECUTIVE_USER_ID}`,
      );
    }

    const user = existingByEmail
      ? await prisma.user.update({
          where: { id: existingByEmail.id },
          data: {
            password: passwordHash,
            name: existingByEmail.name ?? "Play Store Reviewer",
            role: Role.USER,
            isOtpBypassed: true,
            otpCode: null,
            otpExpiry: null,
            allowSimulation: false,
            cryptoArbitrageEnabled: false,
            cryptoBalance: 0,
          },
        })
      : await prisma.user.create({
          data: {
            email,
            password: passwordHash,
            name: "Play Store Reviewer",
            mobile: null,
            role: Role.USER,
            isOtpBypassed: true,
            allowSimulation: false,
            cryptoArbitrageEnabled: false,
            cryptoBalance: 0,
          },
        });

    if (user.id === PROTECTED_EXECUTIVE_USER_ID) {
      throw new Error(
        `Abort: refusing to modify protected executive user ${PROTECTED_EXECUTIVE_USER_ID}`,
      );
    }

    const exchangeCount = await prisma.exchangeAccount.count({
      where: { userId: user.id },
    });
    if (exchangeCount > 0) {
      throw new Error(
        `Abort: reviewer user ${user.id} already has ${exchangeCount} ExchangeAccount row(s). ` +
          `Remove them manually — this script never creates API keys.`,
      );
    }

    const strategy = await resolvePrimaryStrategy(prisma);
    const baseCapital =
      typeof strategy.baseCapital === "number" && strategy.baseCapital > 0
        ? strategy.baseCapital
        : 10;
    const multiplier = Math.max(
      0.01,
      REVIEWER_DEPLOYED_CAPITAL_USD / baseCapital,
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

    console.log("Play Store reviewer account ready:");
    console.log(`  user id:         ${user.id}`);
    console.log(`  email:           ${user.email}`);
    console.log(`  subscription id: ${subscription.id}`);
    console.log(
      `  strategy:        ${strategy.title} (${strategy.id}) multiplier=${multiplier}`,
    );
    console.log("  isOtpBypassed=true — skips OTP AFTER a correct password.");
    console.log("  ExchangeAccount: none (no API keys).");
  } finally {
    await prisma.$disconnect();
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
