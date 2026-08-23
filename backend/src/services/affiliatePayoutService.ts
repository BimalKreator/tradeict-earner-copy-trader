import {
  CommissionLedgerStatus,
  PayoutRequestStatus,
  Prisma,
  type PrismaClient,
} from "@prisma/client";
import { PrismaClientKnownRequestError } from "@prisma/client/runtime/client";
import { randomUUID } from "crypto";
import { isSalesMemberRole } from "./affiliateMemberService.js";
import {
  calendarPartsInTimeZone,
  DASHBOARD_PNL_DAY_TIMEZONE,
  endOfMonthInTimeZone,
} from "./dashboardMetricsService.js";

export const PAYOUT_LAST_DAY_ONLY_MSG =
  "Payouts can only be requested on the last day of the month (IST).";

export const NO_WITHDRAWABLE_BALANCE_MSG =
  "No withdrawable commission balance.";

export const NOTHING_TO_PAY_OUT_MSG = "nothing to pay out";

export const EMPTY_PAYOUT_COMPLETE_MSG =
  "Payout request has no linked commission ledger rows";

/** True when `ref` is the final calendar day of its month in Asia/Kolkata (IST). */
export function isLastDayOfIstMonth(ref: Date = new Date()): boolean {
  const { year, month, day } = calendarPartsInTimeZone(
    ref,
    DASHBOARD_PNL_DAY_TIMEZONE,
  );
  // Date.UTC(y, month, 0) with 1-based calendar month → last day of that month
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return day === lastDay;
}

/** @deprecated Use {@link isLastDayOfIstMonth} — payout window is IST, not UTC. */
export function isLastDayOfUtcMonth(ref: Date = new Date()): boolean {
  return isLastDayOfIstMonth(ref);
}

/**
 * Exclusive end of the current IST payout window (start of next IST month).
 * Partners may request payout while `now < canRequestPayoutUntil` on the last IST day.
 */
export function getCanRequestPayoutUntil(ref: Date = new Date()): Date {
  return endOfMonthInTimeZone(ref, DASHBOARD_PNL_DAY_TIMEZONE);
}

export function getPayoutWindowState(ref: Date = new Date()): {
  canRequestPayout: boolean;
  canRequestPayoutUntil: string;
} {
  const until = getCanRequestPayoutUntil(ref);
  return {
    canRequestPayout: isLastDayOfIstMonth(ref),
    canRequestPayoutUntil: until.toISOString(),
  };
}

function decimalToNumber(value: Prisma.Decimal | number | null | undefined): number {
  if (value == null) return 0;
  if (typeof value === "number") return value;
  return value.toNumber();
}

export type RequestPartnerPayoutOutcome =
  | { ok: true; payoutRequestId: string; amount: number }
  | { ok: false; status: number; message: string };

export async function requestPartnerPayout(
  prisma: PrismaClient,
  userId: string,
): Promise<RequestPartnerPayoutOutcome> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { role: true },
  });

  if (!user || !isSalesMemberRole(user.role)) {
    return { ok: false, status: 403, message: "Partner access required" };
  }

  if (!isLastDayOfIstMonth()) {
    return { ok: false, status: 400, message: PAYOUT_LAST_DAY_ONLY_MSG };
  }

  const now = new Date();
  const claimToken = randomUUID();

  try {
    const result = await prisma.$transaction(async (tx) => {
      // Claim first — only one concurrent request can move these rows.
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
        return null;
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
        return null;
      }

      const amount = ledgers.reduce(
        (sum, row) => sum.plus(row.amount),
        new Prisma.Decimal(0),
      );

      if (amount.lte(0)) {
        return null;
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
        payoutRequestId: payout.id,
        amount: amount.toNumber(),
      };
    });

    if (!result) {
      return { ok: false, status: 409, message: NOTHING_TO_PAY_OUT_MSG };
    }

    return { ok: true, ...result };
  } catch (err) {
    if (
      err instanceof PrismaClientKnownRequestError &&
      err.code === "P2002"
    ) {
      return {
        ok: false,
        status: 409,
        message: "A pending payout request already exists for this partner",
      };
    }
    throw err;
  }
}

export type AdminPartnerPayoutRow = {
  id: string;
  amount: number;
  status: PayoutRequestStatus;
  requestedAt: string;
  user: {
    id: string;
    name: string | null;
    email: string;
    mobile: string | null;
    address: string | null;
    panNumber: string | null;
    role: string;
  };
};

export async function listPendingPartnerPayouts(
  prisma: PrismaClient,
): Promise<AdminPartnerPayoutRow[]> {
  const rows = await prisma.payoutRequest.findMany({
    where: { status: PayoutRequestStatus.PENDING },
    include: {
      user: {
        select: {
          id: true,
          name: true,
          email: true,
          mobile: true,
          address: true,
          panNumber: true,
          role: true,
        },
      },
    },
    orderBy: { requestedAt: "asc" },
  });

  return rows.map((row) => ({
    id: row.id,
    amount: decimalToNumber(row.amount),
    status: row.status,
    requestedAt: row.requestedAt.toISOString(),
    user: row.user,
  }));
}

export type CompletePartnerPayoutOutcome =
  | { ok: true; payoutRequestId: string }
  | { ok: false; status: number; message: string };

export async function completePartnerPayout(
  prisma: PrismaClient,
  payoutRequestId: string,
  adminUserId: string,
  paymentReference: string,
): Promise<CompletePartnerPayoutOutcome> {
  const ref = paymentReference.trim();
  if (!ref) {
    return {
      ok: false,
      status: 400,
      message: "paymentReference (UTR / bank txn id) is required",
    };
  }

  const row = await prisma.payoutRequest.findUnique({
    where: { id: payoutRequestId },
    select: { id: true, status: true, payoutClaimToken: true },
  });

  if (!row) {
    return { ok: false, status: 404, message: "Payout request not found" };
  }

  if (row.status !== PayoutRequestStatus.PENDING) {
    return { ok: false, status: 400, message: "Payout request is not pending" };
  }

  const linkedWhere = row.payoutClaimToken
    ? {
        OR: [
          { payoutRequestId },
          { payoutClaimToken: row.payoutClaimToken },
        ],
        isSimulated: false,
      }
    : { payoutRequestId, isSimulated: false };

  const linkedCount = await prisma.commissionLedger.count({
    where: linkedWhere,
  });

  if (linkedCount === 0) {
    console.error(
      `[Payout] empty payout refused id=${payoutRequestId} claimToken=${row.payoutClaimToken ?? "null"} — no linked ledger rows`,
    );
    return {
      ok: false,
      status: 409,
      message: EMPTY_PAYOUT_COMPLETE_MSG,
    };
  }

  await prisma.payoutRequest.update({
    where: { id: payoutRequestId },
    data: {
      status: PayoutRequestStatus.COMPLETED,
      completedAt: new Date(),
      completedById: adminUserId,
      paymentReference: ref,
    },
  });

  return { ok: true, payoutRequestId };
}
