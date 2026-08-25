import {
  CommissionLedgerStatus,
  PayoutRequestStatus,
  Prisma,
  type PrismaClient,
} from "@prisma/client";
import { PrismaClientKnownRequestError } from "@prisma/client/runtime/client";
import { randomUUID } from "crypto";
import { isSalesMemberRole } from "./affiliateMemberService.js";
import { sumPartnerCommissionNet } from "./commissionBalanceService.js";
import {
  calendarPartsInTimeZone,
  DASHBOARD_PNL_DAY_TIMEZONE,
  endOfMonthInTimeZone,
} from "./dashboardMetricsService.js";

export const PAYOUT_LAST_DAY_ONLY_MSG =
  "Payouts can only be requested on the last day of the month (IST).";

export const NO_WITHDRAWABLE_BALANCE_MSG =
  "No withdrawable commission balance.";

export const INSUFFICIENT_NET_BALANCE_MSG =
  "Commission balance is zero or negative after reversals — payout unavailable.";

export const PAYOUT_EXCEEDS_NET_BALANCE_MSG =
  "Matured commission exceeds signed net balance — contact support.";

export const NOTHING_TO_PAY_OUT_MSG = "nothing to pay out";

export const EMPTY_PAYOUT_COMPLETE_MSG =
  "Payout request has no linked commission ledger rows";

export const ACTIVE_PAYOUT_EXISTS_MSG =
  "An active payout request already exists for this partner";

const VALID_TRANSITIONS: Record<
  PayoutRequestStatus,
  ReadonlySet<PayoutRequestStatus>
> = {
  [PayoutRequestStatus.PENDING]: new Set([
    PayoutRequestStatus.APPROVED,
    PayoutRequestStatus.REJECTED,
  ]),
  [PayoutRequestStatus.APPROVED]: new Set([
    PayoutRequestStatus.COMPLETED,
    PayoutRequestStatus.REJECTED,
  ]),
  [PayoutRequestStatus.COMPLETED]: new Set(),
  [PayoutRequestStatus.REJECTED]: new Set(),
};

export class PayoutTransitionError extends Error {
  readonly statusCode: number;

  constructor(message: string, statusCode = 400) {
    super(message);
    this.name = "PayoutTransitionError";
    this.statusCode = statusCode;
  }
}

export class PayoutNotFoundError extends Error {
  readonly statusCode = 404;

  constructor(payoutRequestId: string) {
    super(`Payout request not found: ${payoutRequestId}`);
    this.name = "PayoutNotFoundError";
  }
}

/** True when `ref` is the final calendar day of its month in Asia/Kolkata (IST). */
export function isLastDayOfIstMonth(ref: Date = new Date()): boolean {
  const { year, month, day } = calendarPartsInTimeZone(
    ref,
    DASHBOARD_PNL_DAY_TIMEZONE,
  );
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return day === lastDay;
}

/** @deprecated Use {@link isLastDayOfIstMonth} — payout window is IST, not UTC. */
export function isLastDayOfUtcMonth(ref: Date = new Date()): boolean {
  return isLastDayOfIstMonth(ref);
}

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

function assertValidPayoutTransition(
  from: PayoutRequestStatus,
  to: PayoutRequestStatus,
): void {
  const allowed = VALID_TRANSITIONS[from];
  if (!allowed.has(to)) {
    throw new PayoutTransitionError(
      `Invalid payout status transition: ${from} → ${to}. ` +
        `Allowed from ${from}: ${[...allowed].join(", ") || "none"}.`,
    );
  }
}

function linkedLedgerWhere(
  payoutRequestId: string,
  payoutClaimToken: string | null,
): Prisma.CommissionLedgerWhereInput {
  return payoutClaimToken
    ? {
        OR: [{ payoutRequestId }, { payoutClaimToken }],
        isSimulated: false,
      }
    : { payoutRequestId, isSimulated: false };
}

async function releaseClaimedLedgerRows(
  tx: Prisma.TransactionClient,
  payoutRequestId: string,
  payoutClaimToken: string | null,
): Promise<number> {
  const released = await tx.commissionLedger.updateMany({
    where: {
      ...linkedLedgerWhere(payoutRequestId, payoutClaimToken),
      status: CommissionLedgerStatus.WITHDRAWN,
    },
    data: {
      status: CommissionLedgerStatus.WITHDRAWABLE,
      payoutClaimToken: null,
      payoutRequestId: null,
      withdrawnAt: null,
    },
  });
  return released.count;
}

export type PayoutTransitionOpts = {
  adminUserId: string;
  paymentReference?: string;
  reason?: string;
};

/**
 * Single entry point for PayoutRequest status changes.
 * REJECT releases claimed WITHDRAWN rows back to WITHDRAWABLE.
 */
export async function transitionPayoutRequest(
  prisma: PrismaClient,
  payoutRequestId: string,
  toStatus: PayoutRequestStatus,
  opts: PayoutTransitionOpts,
): Promise<{ payoutRequestId: string; status: PayoutRequestStatus }> {
  const row = await prisma.payoutRequest.findUnique({
    where: { id: payoutRequestId },
    select: {
      id: true,
      status: true,
      payoutClaimToken: true,
    },
  });

  if (!row) {
    throw new PayoutNotFoundError(payoutRequestId);
  }

  assertValidPayoutTransition(row.status, toStatus);

  const now = new Date();

  if (toStatus === PayoutRequestStatus.APPROVED) {
    const linkedCount = await prisma.commissionLedger.count({
      where: linkedLedgerWhere(row.id, row.payoutClaimToken),
    });
    if (linkedCount === 0) {
      console.error(
        `[Payout] approve refused id=${payoutRequestId} — no linked ledger rows`,
      );
      throw new PayoutTransitionError(
        EMPTY_PAYOUT_COMPLETE_MSG.replace("complete", "approve"),
        409,
      );
    }

    await prisma.payoutRequest.update({
      where: { id: payoutRequestId },
      data: {
        status: PayoutRequestStatus.APPROVED,
        approvedAt: now,
        approvedById: opts.adminUserId,
        approvalReason: opts.reason?.trim() || null,
      },
    });
    return { payoutRequestId, status: PayoutRequestStatus.APPROVED };
  }

  if (toStatus === PayoutRequestStatus.REJECTED) {
    const reason = opts.reason?.trim() ?? "";
    if (!reason) {
      throw new PayoutTransitionError(
        "rejectionReason is required when rejecting a payout",
      );
    }

    await prisma.$transaction(async (tx) => {
      const released = await releaseClaimedLedgerRows(
        tx,
        row.id,
        row.payoutClaimToken,
      );
      if (released === 0) {
        console.error(
          `[Payout] reject id=${payoutRequestId} claimToken=${row.payoutClaimToken ?? "null"} — no WITHDRAWN rows released`,
        );
      }

      await tx.payoutRequest.update({
        where: { id: payoutRequestId },
        data: {
          status: PayoutRequestStatus.REJECTED,
          rejectedAt: now,
          rejectedById: opts.adminUserId,
          rejectionReason: reason,
        },
      });
    });

    console.info(
      `[Payout] rejected id=${payoutRequestId} by=${opts.adminUserId} reason=${reason}`,
    );
    return { payoutRequestId, status: PayoutRequestStatus.REJECTED };
  }

  if (toStatus === PayoutRequestStatus.COMPLETED) {
    const ref = opts.paymentReference?.trim() ?? "";
    if (!ref) {
      throw new PayoutTransitionError(
        "paymentReference (UTR / bank txn id) is required",
      );
    }

    const linkedCount = await prisma.commissionLedger.count({
      where: linkedLedgerWhere(row.id, row.payoutClaimToken),
    });
    if (linkedCount === 0) {
      console.error(
        `[Payout] complete refused id=${payoutRequestId} claimToken=${row.payoutClaimToken ?? "null"} — no linked ledger rows`,
      );
      throw new PayoutTransitionError(EMPTY_PAYOUT_COMPLETE_MSG, 409);
    }

    await prisma.payoutRequest.update({
      where: { id: payoutRequestId },
      data: {
        status: PayoutRequestStatus.COMPLETED,
        completedAt: now,
        completedById: opts.adminUserId,
        paymentReference: ref,
      },
    });
    return { payoutRequestId, status: PayoutRequestStatus.COMPLETED };
  }

  throw new PayoutTransitionError(`Unsupported target status: ${toStatus}`);
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

  const activeRequest = await prisma.payoutRequest.findFirst({
    where: {
      userId,
      status: {
        in: [PayoutRequestStatus.PENDING, PayoutRequestStatus.APPROVED],
      },
    },
    select: { id: true },
  });
  if (activeRequest) {
    return { ok: false, status: 409, message: ACTIVE_PAYOUT_EXISTS_MSG };
  }

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
      };
    });

    if (result.kind === "refused") {
      if (result.reason === "net") {
        return {
          ok: false,
          status: 409,
          message: INSUFFICIENT_NET_BALANCE_MSG,
        };
      }
      return { ok: false, status: 409, message: NOTHING_TO_PAY_OUT_MSG };
    }

    return { ok: true, payoutRequestId: result.payoutRequestId, amount: result.amount };
  } catch (err) {
    if (err instanceof PayoutTransitionError) {
      return { ok: false, status: err.statusCode, message: err.message };
    }
    if (
      err instanceof PrismaClientKnownRequestError &&
      err.code === "P2002"
    ) {
      return {
        ok: false,
        status: 409,
        message: ACTIVE_PAYOUT_EXISTS_MSG,
      };
    }
    throw err;
  }
}

type AdminActorSummary = {
  id: string;
  name: string | null;
  email: string;
} | null;

export type AdminPartnerPayoutRow = {
  id: string;
  amount: number;
  status: PayoutRequestStatus;
  requestedAt: string;
  approvedAt: string | null;
  approvedBy: AdminActorSummary;
  approvalReason: string | null;
  rejectedAt: string | null;
  rejectedBy: AdminActorSummary;
  rejectionReason: string | null;
  completedAt: string | null;
  completedBy: AdminActorSummary;
  paymentReference: string | null;
  /** Outstanding manual clawback for this partner (money already paid out). */
  clawbackOwed: number;
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

export type AdminPartnerClawbackRow = {
  beneficiaryUserId: string;
  amountOwed: number;
  user: {
    id: string;
    name: string | null;
    email: string;
    role: string;
  };
};

const adminPayoutInclude = {
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
  approvedBy: { select: { id: true, name: true, email: true } },
  rejectedBy: { select: { id: true, name: true, email: true } },
  completedBy: { select: { id: true, name: true, email: true } },
} as const;

function mapAdminPayoutRow(
  row: Prisma.PayoutRequestGetPayload<{ include: typeof adminPayoutInclude }>,
  clawbackOwed = 0,
): AdminPartnerPayoutRow {
  return {
    id: row.id,
    amount: decimalToNumber(row.amount),
    status: row.status,
    requestedAt: row.requestedAt.toISOString(),
    approvedAt: row.approvedAt?.toISOString() ?? null,
    approvedBy: row.approvedBy,
    approvalReason: row.approvalReason,
    rejectedAt: row.rejectedAt?.toISOString() ?? null,
    rejectedBy: row.rejectedBy,
    rejectionReason: row.rejectionReason,
    completedAt: row.completedAt?.toISOString() ?? null,
    completedBy: row.completedBy,
    paymentReference: row.paymentReference,
    clawbackOwed,
    user: row.user,
  };
}

async function loadClawbackOwedByPartner(
  prisma: PrismaClient,
  userIds: string[],
): Promise<Map<string, number>> {
  if (userIds.length === 0) return new Map();

  const groups = await prisma.commissionLedger.groupBy({
    by: ["beneficiaryUserId"],
    where: {
      beneficiaryUserId: { in: userIds },
      needsClawback: true,
      isSimulated: false,
    },
    _sum: { amount: true },
  });

  const map = new Map<string, number>();
  for (const row of groups) {
    const sum = row._sum.amount ?? new Prisma.Decimal(0);
    map.set(row.beneficiaryUserId, Math.abs(sum.toNumber()));
  }
  return map;
}

/** Partners with outstanding manual clawback (commission paid out before reversal). */
export async function listPartnerClawbackQueue(
  prisma: PrismaClient,
): Promise<AdminPartnerClawbackRow[]> {
  const groups = await prisma.commissionLedger.groupBy({
    by: ["beneficiaryUserId"],
    where: { needsClawback: true, isSimulated: false },
    _sum: { amount: true },
  });

  if (groups.length === 0) return [];

  const userIds = groups.map((g) => g.beneficiaryUserId);
  const users = await prisma.user.findMany({
    where: { id: { in: userIds } },
    select: { id: true, name: true, email: true, role: true },
  });
  const userById = new Map(users.map((u) => [u.id, u]));

  const rows: AdminPartnerClawbackRow[] = [];
  for (const row of groups) {
    const sum = row._sum.amount ?? new Prisma.Decimal(0);
    const amountOwed = Math.abs(sum.toNumber());
    const user = userById.get(row.beneficiaryUserId);
    if (!user || amountOwed <= 0) continue;
    rows.push({
      beneficiaryUserId: row.beneficiaryUserId,
      amountOwed,
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        role: String(user.role),
      },
    });
  }

  rows.sort((a, b) => b.amountOwed - a.amountOwed);
  return rows;
}

/** Admin queue — actionable (PENDING, APPROVED) payout requests. */
export async function listActionablePartnerPayouts(
  prisma: PrismaClient,
): Promise<AdminPartnerPayoutRow[]> {
  const rows = await prisma.payoutRequest.findMany({
    where: {
      status: {
        in: [PayoutRequestStatus.PENDING, PayoutRequestStatus.APPROVED],
      },
    },
    include: adminPayoutInclude,
    orderBy: { requestedAt: "asc" },
  });

  const clawbackByUser = await loadClawbackOwedByPartner(
    prisma,
    rows.map((row) => row.userId),
  );

  return rows.map((row) =>
    mapAdminPayoutRow(row, clawbackByUser.get(row.userId) ?? 0),
  );
}

/** @deprecated Use {@link listActionablePartnerPayouts}. */
export const listPendingPartnerPayouts = listActionablePartnerPayouts;

export type PartnerPayoutRequestSummary = {
  id: string;
  amount: number;
  status: PayoutRequestStatus;
  /** Partner-facing label: Requested / Approved / Paid / Rejected */
  statusLabel: string;
  requestedAt: string;
  approvedAt: string | null;
  completedAt: string | null;
  rejectedAt: string | null;
  rejectionReason: string | null;
  paymentReference: string | null;
};

export function partnerPayoutStatusLabel(
  status: PayoutRequestStatus,
): string {
  switch (status) {
    case PayoutRequestStatus.PENDING:
      return "Requested";
    case PayoutRequestStatus.APPROVED:
      return "Approved";
    case PayoutRequestStatus.COMPLETED:
      return "Paid";
    case PayoutRequestStatus.REJECTED:
      return "Rejected";
    default:
      return status;
  }
}

export async function getLatestPartnerPayoutRequest(
  prisma: PrismaClient,
  userId: string,
): Promise<PartnerPayoutRequestSummary | null> {
  const row = await prisma.payoutRequest.findFirst({
    where: { userId },
    orderBy: { requestedAt: "desc" },
    select: {
      id: true,
      amount: true,
      status: true,
      requestedAt: true,
      approvedAt: true,
      completedAt: true,
      rejectedAt: true,
      rejectionReason: true,
      paymentReference: true,
    },
  });

  if (!row) return null;

  return {
    id: row.id,
    amount: decimalToNumber(row.amount),
    status: row.status,
    statusLabel: partnerPayoutStatusLabel(row.status),
    requestedAt: row.requestedAt.toISOString(),
    approvedAt: row.approvedAt?.toISOString() ?? null,
    completedAt: row.completedAt?.toISOString() ?? null,
    rejectedAt: row.rejectedAt?.toISOString() ?? null,
    rejectionReason: row.rejectionReason,
    paymentReference: row.paymentReference,
  };
}

export type PayoutServiceOutcome =
  | { ok: true; payoutRequestId: string; status: PayoutRequestStatus }
  | { ok: false; status: number; message: string };

function mapTransitionError(err: unknown): PayoutServiceOutcome | null {
  if (err instanceof PayoutNotFoundError) {
    return { ok: false, status: 404, message: err.message };
  }
  if (err instanceof PayoutTransitionError) {
    return { ok: false, status: err.statusCode, message: err.message };
  }
  return null;
}

export async function approvePartnerPayout(
  prisma: PrismaClient,
  payoutRequestId: string,
  adminUserId: string,
  reason?: string,
): Promise<PayoutServiceOutcome> {
  try {
    const opts: PayoutTransitionOpts = { adminUserId };
    if (reason?.trim()) {
      opts.reason = reason.trim();
    }
    const result = await transitionPayoutRequest(
      prisma,
      payoutRequestId,
      PayoutRequestStatus.APPROVED,
      opts,
    );
    return { ok: true, ...result };
  } catch (err) {
    const mapped = mapTransitionError(err);
    if (mapped) return mapped;
    throw err;
  }
}

export async function rejectPartnerPayout(
  prisma: PrismaClient,
  payoutRequestId: string,
  adminUserId: string,
  reason: string,
): Promise<PayoutServiceOutcome> {
  try {
    const result = await transitionPayoutRequest(
      prisma,
      payoutRequestId,
      PayoutRequestStatus.REJECTED,
      { adminUserId, reason },
    );
    return { ok: true, ...result };
  } catch (err) {
    const mapped = mapTransitionError(err);
    if (mapped) return mapped;
    throw err;
  }
}

export async function completePartnerPayout(
  prisma: PrismaClient,
  payoutRequestId: string,
  adminUserId: string,
  paymentReference: string,
): Promise<PayoutServiceOutcome> {
  try {
    const result = await transitionPayoutRequest(
      prisma,
      payoutRequestId,
      PayoutRequestStatus.COMPLETED,
      { adminUserId, paymentReference },
    );
    return { ok: true, ...result };
  } catch (err) {
    const mapped = mapTransitionError(err);
    if (mapped) return mapped;
    throw err;
  }
}
