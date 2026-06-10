import {
  CommissionLedgerStatus,
  PayoutRequestStatus,
  type PrismaClient,
} from "@prisma/client";
import { isSalesMemberRole } from "./affiliateMemberService.js";

export const PAYOUT_LAST_DAY_ONLY_MSG =
  "Payouts can only be requested on the last day of the month.";

export const NO_WITHDRAWABLE_BALANCE_MSG =
  "No withdrawable commission balance.";

/** True when `ref` is the final UTC calendar day of its month. */
export function isLastDayOfUtcMonth(ref: Date = new Date()): boolean {
  const year = ref.getUTCFullYear();
  const month = ref.getUTCMonth();
  const day = ref.getUTCDate();
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return day === lastDay;
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

  if (!isLastDayOfUtcMonth()) {
    return { ok: false, status: 400, message: PAYOUT_LAST_DAY_ONLY_MSG };
  }

  const preview = await prisma.commissionLedger.aggregate({
    where: {
      beneficiaryUserId: userId,
      status: CommissionLedgerStatus.WITHDRAWABLE,
    },
    _sum: { amount: true },
  });

  const previewAmount = preview._sum.amount ?? 0;
  if (previewAmount <= 0) {
    return { ok: false, status: 400, message: NO_WITHDRAWABLE_BALANCE_MSG };
  }

  const now = new Date();
  const result = await prisma.$transaction(async (tx) => {
    const ledgers = await tx.commissionLedger.findMany({
      where: {
        beneficiaryUserId: userId,
        status: CommissionLedgerStatus.WITHDRAWABLE,
      },
      select: { id: true, amount: true },
    });

    if (ledgers.length === 0) {
      return null;
    }

    const amount = ledgers.reduce((sum, row) => sum + row.amount, 0);
    const payout = await tx.payoutRequest.create({
      data: {
        userId,
        amount,
        status: PayoutRequestStatus.PENDING,
      },
    });

    await tx.commissionLedger.updateMany({
      where: {
        beneficiaryUserId: userId,
        status: CommissionLedgerStatus.WITHDRAWABLE,
      },
      data: {
        status: CommissionLedgerStatus.WITHDRAWN,
        withdrawnAt: now,
        payoutRequestId: payout.id,
      },
    });

    return { payoutRequestId: payout.id, amount };
  });

  if (!result) {
    return { ok: false, status: 400, message: NO_WITHDRAWABLE_BALANCE_MSG };
  }

  return { ok: true, ...result };
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
    amount: row.amount,
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
): Promise<CompletePartnerPayoutOutcome> {
  const row = await prisma.payoutRequest.findUnique({
    where: { id: payoutRequestId },
    select: { id: true, status: true },
  });

  if (!row) {
    return { ok: false, status: 404, message: "Payout request not found" };
  }

  if (row.status !== PayoutRequestStatus.PENDING) {
    return { ok: false, status: 400, message: "Payout request is not pending" };
  }

  await prisma.payoutRequest.update({
    where: { id: payoutRequestId },
    data: {
      status: PayoutRequestStatus.COMPLETED,
      completedAt: new Date(),
      completedById: adminUserId,
    },
  });

  return { ok: true, payoutRequestId };
}
