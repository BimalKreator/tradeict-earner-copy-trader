import "dotenv/config";
import { randomUUID } from "crypto";
import pg from "pg";
import { PrismaPg } from "@prisma/adapter-pg";
import {
  CommissionLedgerStatus,
  PayoutRequestStatus,
  Prisma,
  Role,
  SalesTier,
  PrismaClient,
} from "@prisma/client";
import { signAuthToken } from "../../utils/authToken.js";
import { isSalesMemberRole } from "../../services/affiliateMemberService.js";
import {
  INSUFFICIENT_NET_BALANCE_MSG,
  NOTHING_TO_PAY_OUT_MSG,
  PAYOUT_EXCEEDS_NET_BALANCE_MSG,
  PayoutTransitionError,
} from "../../services/affiliatePayoutService.js";
import { sumPartnerCommissionNet } from "../../services/commissionBalanceService.js";

/** Must never be written to by the harness — abort if targeted. */
export const PROTECTED_USER_IDS = new Set([
  "08ade383-6f6a-4e63-946a-76651a6fad3e",
  "695f8b44-0af1-4d87-908b-38d9c942745a",
  "9b4bd2bd-69e5-42f8-a592-e011bb014d3e",
]);

export const TEST_ID_PREFIX = "TEST-P17-";

type CreatedRows = {
  userIds: string[];
  affiliateProfileIds: string[];
  commissionLedgerIds: string[];
  payoutRequestIds: string[];
  monthlyRevenueInvoiceIds: string[];
};

export function createHarnessPrisma(): PrismaClient {
  const connectionString = process.env.DATABASE_URL?.trim();
  if (!connectionString) {
    throw new Error("DATABASE_URL is required for the test harness");
  }
  const pool = new pg.Pool({ connectionString });
  const adapter = new PrismaPg(pool);
  return new PrismaClient({ adapter });
}

export function assertTestMarker(value: string, label: string): void {
  if (!value.startsWith(TEST_ID_PREFIX)) {
    throw new Error(
      `${label} must start with ${TEST_ID_PREFIX} — refusing unsafe write`,
    );
  }
}

export function assertNotProtectedUserId(userId: string): void {
  if (PROTECTED_USER_IDS.has(userId)) {
    throw new Error(`Refusing to touch protected user id ${userId}`);
  }
}

export class TestRegistry {
  private readonly created: CreatedRows = {
    userIds: [],
    affiliateProfileIds: [],
    commissionLedgerIds: [],
    payoutRequestIds: [],
    monthlyRevenueInvoiceIds: [],
  };

  trackUser(id: string): void {
    assertNotProtectedUserId(id);
    this.created.userIds.push(id);
  }

  trackAffiliateProfile(id: string): void {
    this.created.affiliateProfileIds.push(id);
  }

  trackCommissionLedger(id: string): void {
    this.created.commissionLedgerIds.push(id);
  }

  trackPayoutRequest(id: string): void {
    this.created.payoutRequestIds.push(id);
  }

  untrackPayoutRequest(id: string): void {
    this.created.payoutRequestIds = this.created.payoutRequestIds.filter(
      (rowId) => rowId !== id,
    );
  }

  trackMonthlyRevenueInvoice(id: string): void {
    this.created.monthlyRevenueInvoiceIds.push(id);
  }

  async cleanup(prisma: PrismaClient): Promise<void> {
    if (this.created.monthlyRevenueInvoiceIds.length > 0) {
      await prisma.commissionLedger.deleteMany({
        where: {
          monthlyRevenueInvoiceId: {
            in: [...this.created.monthlyRevenueInvoiceIds],
          },
        },
      });
    }

    if (this.created.commissionLedgerIds.length > 0) {
      await prisma.commissionLedger.deleteMany({
        where: { id: { in: [...this.created.commissionLedgerIds] } },
      });
    }
    if (this.created.payoutRequestIds.length > 0) {
      await prisma.payoutRequest.deleteMany({
        where: { id: { in: [...this.created.payoutRequestIds] } },
      });
    }
    if (this.created.monthlyRevenueInvoiceIds.length > 0) {
      await prisma.monthlyRevenueInvoice.deleteMany({
        where: { id: { in: [...this.created.monthlyRevenueInvoiceIds] } },
      });
    }
    if (this.created.affiliateProfileIds.length > 0) {
      await prisma.affiliateProfile.deleteMany({
        where: { id: { in: [...this.created.affiliateProfileIds] } },
      });
    }
    if (this.created.userIds.length > 0) {
      for (const userId of this.created.userIds) {
        assertNotProtectedUserId(userId);
      }
      await prisma.commissionLedger.deleteMany({
        where: {
          OR: [
            { sourceUserId: { in: [...this.created.userIds] } },
            { beneficiaryUserId: { in: [...this.created.userIds] } },
          ],
        },
      });
      await prisma.monthlyRevenueInvoice.deleteMany({
        where: { userId: { in: [...this.created.userIds] } },
      });
      await prisma.dailyPnlSnapshot.deleteMany({
        where: { userId: { in: [...this.created.userIds] } },
      });
      await prisma.structurePnl.deleteMany({
        where: { userId: { in: [...this.created.userIds] } },
      });
      await prisma.deltaLedgerEntry.deleteMany({
        where: { userId: { in: [...this.created.userIds] } },
      });
      await prisma.userStrategySubscription.deleteMany({
        where: { userId: { in: [...this.created.userIds] } },
      });
      await prisma.walletWithdrawalRequest.deleteMany({
        where: { userId: { in: [...this.created.userIds] } },
      });
      await prisma.transaction.deleteMany({
        where: { userId: { in: [...this.created.userIds] } },
      });
      await prisma.wallet.deleteMany({
        where: { userId: { in: [...this.created.userIds] } },
      });
      await prisma.user.deleteMany({
        where: { id: { in: [...this.created.userIds] } },
      });
    }
  }
}

export type ClaimPartnerPayoutResult =
  | { ok: true; payoutRequestId: string; amount: number; claimToken: string }
  | { ok: false; message: string };

/**
 * Mirrors the claim transaction inside requestPartnerPayout (production).
 * Testability defect: IST last-day gate is fused with claim in requestPartnerPayout.
 */
export async function claimPartnerPayoutDirect(
  prisma: PrismaClient,
  userId: string,
): Promise<ClaimPartnerPayoutResult> {
  assertNotProtectedUserId(userId);
  const now = new Date();
  const claimToken = randomUUID();

  try {
    const result = await prisma.$transaction(async (tx) => {
      const signedNet = await sumPartnerCommissionNet(tx, userId);
      if (signedNet.lte(0)) {
        return { kind: "refused" as const, reason: "net" as const };
      }

      const claimed = await tx.commissionLedger.updateMany({
        where: {
          beneficiaryUserId: userId,
          status: CommissionLedgerStatus.WITHDRAWABLE,
          isSimulated: false,
        },
        data: {
          status: CommissionLedgerStatus.WITHDRAWN,
          withdrawnAt: now,
          payoutClaimToken: claimToken,
        },
      });

      if (claimed.count === 0) {
        return { kind: "refused" as const, reason: "empty" as const };
      }

      const ledgers = await tx.commissionLedger.findMany({
        where: {
          beneficiaryUserId: userId,
          payoutClaimToken: claimToken,
          isSimulated: false,
        },
        select: { id: true, amount: true },
      });

      if (ledgers.length === 0) {
        return { kind: "refused" as const, reason: "empty" as const };
      }

      const amount = ledgers.reduce(
        (sum, row) => sum.plus(row.amount),
        new Prisma.Decimal(0),
      );

      if (amount.lte(0)) {
        return { kind: "refused" as const, reason: "net" as const };
      }

      if (amount.gt(signedNet)) {
        throw new PayoutTransitionError(PAYOUT_EXCEEDS_NET_BALANCE_MSG, 409);
      }

      const payout = await tx.payoutRequest.create({
        data: {
          userId,
          amount,
          status: PayoutRequestStatus.PENDING,
          payoutClaimToken: claimToken,
        },
      });

      await tx.commissionLedger.updateMany({
        where: {
          payoutClaimToken: claimToken,
          beneficiaryUserId: userId,
        },
        data: {
          payoutRequestId: payout.id,
        },
      });

      return {
        kind: "ok" as const,
        payoutRequestId: payout.id,
        amount: amount.toNumber(),
        claimToken,
      };
    });

    if (result.kind === "refused") {
      if (result.reason === "net") {
        return { ok: false, message: INSUFFICIENT_NET_BALANCE_MSG };
      }
      return { ok: false, message: NOTHING_TO_PAY_OUT_MSG };
    }

    return {
      ok: true,
      payoutRequestId: result.payoutRequestId,
      amount: result.amount,
      claimToken: result.claimToken,
    };
  } catch (err) {
    if (err instanceof PayoutTransitionError) {
      return { ok: false, message: err.message };
    }
    throw err;
  }
}

export async function rollbackTestPayoutClaim(
  prisma: PrismaClient,
  args: {
    beneficiaryUserId: string;
    payoutRequestId: string;
    claimToken: string;
  },
): Promise<void> {
  assertNotProtectedUserId(args.beneficiaryUserId);
  await prisma.commissionLedger.updateMany({
    where: {
      beneficiaryUserId: args.beneficiaryUserId,
      payoutClaimToken: args.claimToken,
      status: CommissionLedgerStatus.WITHDRAWN,
    },
    data: {
      status: CommissionLedgerStatus.WITHDRAWABLE,
      payoutClaimToken: null,
      payoutRequestId: null,
      withdrawnAt: null,
    },
  });
  await prisma.payoutRequest.delete({
    where: { id: args.payoutRequestId },
  });
}

export class TestFixtureFactory {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly registry: TestRegistry,
  ) {}

  mintUserToken(
    userId: string,
    email: string,
    role: Role,
    tokenVersion = 0,
  ): string {
    const secret = process.env.JWT_SECRET?.trim();
    if (!secret) {
      throw new Error("JWT_SECRET is required to mint harness tokens");
    }
    return signAuthToken({ sub: userId, email, role, tokenVersion }, secret);
  }

  async createTestUser(prefix: string, role: Role): Promise<{
    id: string;
    email: string;
    marker: string;
    token: string;
  }> {
    assertTestMarker(prefix, "prefix");
    const marker = `${prefix}-${randomUUID()}`;
    const email = `${marker}@test.local`.toLowerCase();

    const user = await this.prisma.user.create({
      data: {
        email,
        password: "test-harness-no-login",
        name: marker,
        role,
      },
      select: { id: true, email: true, role: true, tokenVersion: true },
    });
    this.registry.trackUser(user.id);

    if (isSalesMemberRole(role)) {
      const profile = await this.prisma.affiliateProfile.create({
        data: {
          userId: user.id,
          referralCode: marker,
        },
        select: { id: true },
      });
      this.registry.trackAffiliateProfile(profile.id);
    }

    return {
      id: user.id,
      email: user.email,
      marker,
      token: this.mintUserToken(
        user.id,
        user.email,
        user.role,
        user.tokenVersion,
      ),
    };
  }

  async createTestMonthlyRevenueInvoice(args: {
    marker: string;
    userId: string;
    sourceUserId: string;
  }): Promise<{ id: string }> {
    assertTestMarker(args.marker, "marker");
    assertNotProtectedUserId(args.userId);
    assertNotProtectedUserId(args.sourceUserId);

    const now = new Date();
    const row = await this.prisma.monthlyRevenueInvoice.create({
      data: {
        userId: args.userId,
        periodYear: now.getUTCFullYear(),
        periodMonth: now.getUTCMonth() + 1,
        structuresClosed: 1,
        realizedPnl: new Prisma.Decimal(100),
        hwmBefore: new Prisma.Decimal(0),
        hwmAfter: new Prisma.Decimal(100),
        billableProfit: new Prisma.Decimal(100),
        profitSharePct: new Prisma.Decimal(20),
        commissionAmount: new Prisma.Decimal(20),
        status: "INVOICED",
        invoicedAt: now,
        paymentReference: args.marker,
        generatedAt: now,
        isSimulated: false,
      },
      select: { id: true },
    });
    this.registry.trackMonthlyRevenueInvoice(row.id);
    return row;
  }

  async createCommissionRow(args: {
    marker: string;
    sourceUserId: string;
    beneficiaryUserId: string;
    amount: number;
    status: CommissionLedgerStatus;
    monthlyRevenueInvoiceId?: string;
    idempotencySuffix?: string;
  }): Promise<{ id: string; idempotencyKey: string }> {
    assertTestMarker(args.marker, "marker");
    assertNotProtectedUserId(args.sourceUserId);
    assertNotProtectedUserId(args.beneficiaryUserId);

    const idempotencyKey = `${args.marker}:${args.idempotencySuffix ?? "EARNED"}`;
    assertTestMarker(idempotencyKey, "idempotencyKey");

    const profitDate = new Date();
    profitDate.setUTCHours(0, 0, 0, 0);

    const row = await this.prisma.commissionLedger.create({
      data: {
        profitDate,
        sourceUserId: args.sourceUserId,
        beneficiaryUserId: args.beneficiaryUserId,
        amount: new Prisma.Decimal(args.amount),
        appRevenueBase: args.amount * 20,
        commissionRate: 5,
        beneficiaryTier: SalesTier.EXECUTIVE,
        status: args.status,
        unlockDate: new Date(Date.now() + 30 * 86_400_000),
        idempotencyKey,
        monthlyRevenueInvoiceId: args.monthlyRevenueInvoiceId ?? null,
        isSimulated: false,
        withdrawableAt:
          args.status === CommissionLedgerStatus.WITHDRAWABLE ? new Date() : null,
      },
      select: { id: true, idempotencyKey: true },
    });
    this.registry.trackCommissionLedger(row.id);
    return row;
  }

  trackPayoutFromClaim(payoutRequestId: string): void {
    this.registry.trackPayoutRequest(payoutRequestId);
  }

  untrackPayoutRequest(payoutRequestId: string): void {
    this.registry.untrackPayoutRequest(payoutRequestId);
  }

  get registryRef(): TestRegistry {
    return this.registry;
  }
}

export async function verifyNoTestRowLeaks(
  prisma: PrismaClient,
): Promise<string[]> {
  const leaks: string[] = [];

  const users = await prisma.user.findMany({
    where: { email: { startsWith: TEST_ID_PREFIX.toLowerCase() } },
    select: { id: true, email: true },
  });
  for (const row of users) {
    leaks.push(`User.email=${row.email}`);
  }

  const profiles = await prisma.affiliateProfile.findMany({
    where: { referralCode: { startsWith: TEST_ID_PREFIX } },
    select: { referralCode: true },
  });
  for (const row of profiles) {
    leaks.push(`AffiliateProfile.referralCode=${row.referralCode}`);
  }

  const commissions = await prisma.commissionLedger.findMany({
    where: { idempotencyKey: { startsWith: TEST_ID_PREFIX } },
    select: { idempotencyKey: true },
  });
  for (const row of commissions) {
    leaks.push(`CommissionLedger.idempotencyKey=${row.idempotencyKey}`);
  }

  const invoices = await prisma.monthlyRevenueInvoice.findMany({
    where: { paymentReference: { startsWith: TEST_ID_PREFIX } },
    select: { paymentReference: true },
  });
  for (const row of invoices) {
    leaks.push(`MonthlyRevenueInvoice.paymentReference=${row.paymentReference}`);
  }

  const invoiceLinked = await prisma.commissionLedger.findMany({
    where: {
      monthlyRevenueInvoice: {
        paymentReference: { startsWith: TEST_ID_PREFIX },
      },
    },
    select: { id: true, idempotencyKey: true },
  });
  for (const row of invoiceLinked) {
    leaks.push(`CommissionLedger.id=${row.id} key=${row.idempotencyKey}`);
  }

  return leaks;
}
