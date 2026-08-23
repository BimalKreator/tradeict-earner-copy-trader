import { Prisma, type PrismaClient } from "@prisma/client";
import { roundInr, usdToInr } from "./paymentFeeService.js";
import { getUsdInrRate } from "./settingsService.js";
import {
  distributeMonthlyRevenueInvoiceCommissions,
  markMonthlyRevenueInvoiceCommissionsAsPayable,
  resolveCommissionChainForUser,
  reverseMonthlyRevenueInvoiceCommissionsForCreditNote,
  reverseMonthlyRevenueInvoiceCommissionsOnVoid,
} from "./affiliateCommissionService.js";

/** Matches legacy `billingService` INVOICE_DUE_DAYS; override via env. */
const LEGACY_INVOICE_DUE_DAYS = 5;
const MS_PER_DAY = 86_400_000;

export const INVOICE_STATUS = {
  ACCRUED: "ACCRUED",
  INVOICED: "INVOICED",
  PAID: "PAID",
  VOID: "VOID",
} as const;

export type MonthlyRevenueInvoiceStatus =
  (typeof INVOICE_STATUS)[keyof typeof INVOICE_STATUS];

const VALID_TRANSITIONS: Record<string, ReadonlySet<string>> = {
  [INVOICE_STATUS.ACCRUED]: new Set([
    INVOICE_STATUS.INVOICED,
    INVOICE_STATUS.VOID,
  ]),
  [INVOICE_STATUS.INVOICED]: new Set([
    INVOICE_STATUS.PAID,
    INVOICE_STATUS.VOID,
  ]),
  [INVOICE_STATUS.PAID]: new Set<string>(),
  [INVOICE_STATUS.VOID]: new Set<string>(),
};

export class InvoiceTransitionError extends Error {
  readonly statusCode = 400;

  constructor(message: string) {
    super(message);
    this.name = "InvoiceTransitionError";
  }
}

export class InvoiceNotFoundError extends Error {
  readonly statusCode = 404;

  constructor(invoiceId: string) {
    super(`Monthly revenue invoice not found: ${invoiceId}`);
    this.name = "InvoiceNotFoundError";
  }
}

export function revenueInvoiceDueDays(): number {
  const raw = process.env.REVENUE_INVOICE_DUE_DAYS;
  if (raw != null && raw.trim() !== "") {
    const n = Number.parseInt(raw, 10);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return LEGACY_INVOICE_DUE_DAYS;
}

/** Same convention as legacy Invoice: dueDate = invoicedAt + N days. */
export function computeRevenueInvoiceDueDate(from: Date): Date {
  return new Date(from.getTime() + revenueInvoiceDueDays() * MS_PER_DAY);
}

export function isInvoiceFrozen(status: string): boolean {
  return (
    status === INVOICE_STATUS.INVOICED ||
    status === INVOICE_STATUS.PAID ||
    status === INVOICE_STATUS.VOID
  );
}

export function assertValidInvoiceTransition(from: string, to: string): void {
  const allowed = VALID_TRANSITIONS[from];
  if (!allowed?.has(to)) {
    throw new InvoiceTransitionError(
      `Invalid invoice status transition: ${from} → ${to}. ` +
        `Allowed from ${from}: ${allowed ? [...allowed].join(", ") || "none" : "unknown status"}.`,
    );
  }
}

export function parseMonthlyRevenueInvoiceStatus(
  raw: unknown,
): MonthlyRevenueInvoiceStatus {
  if (typeof raw !== "string") {
    throw new InvoiceTransitionError("status must be a string");
  }
  const normalized = raw.trim().toUpperCase();
  const values = Object.values(INVOICE_STATUS) as string[];
  if (!values.includes(normalized)) {
    throw new InvoiceTransitionError(
      `status must be one of: ${values.join(", ")}`,
    );
  }
  return normalized as MonthlyRevenueInvoiceStatus;
}

function pinInrAmount(
  commissionAmountUsd: Prisma.Decimal,
  usdInrRate: number,
): { amountInr: Prisma.Decimal; usdInrRate: Prisma.Decimal } {
  const amountInr = new Prisma.Decimal(
    roundInr(usdToInr(commissionAmountUsd.toNumber(), usdInrRate)),
  );
  return {
    amountInr,
    usdInrRate: new Prisma.Decimal(usdInrRate),
  };
}

/**
 * Single entry point for MonthlyRevenueInvoice status changes.
 * ACCRUED → INVOICED pins amountInr + usdInrRate at transition time.
 */
export async function transitionMonthlyRevenueInvoiceStatus(
  prisma: PrismaClient,
  invoiceId: string,
  targetStatus: MonthlyRevenueInvoiceStatus,
  opts?: {
    reason?: string;
    paymentReference?: string;
    usdInrRate?: number;
  },
): Promise<Prisma.MonthlyRevenueInvoiceGetPayload<object>> {
  const invoice = await prisma.monthlyRevenueInvoice.findUnique({
    where: { id: invoiceId },
  });
  if (!invoice) {
    throw new InvoiceNotFoundError(invoiceId);
  }

  if (invoice.status === targetStatus) {
    return invoice;
  }

  assertValidInvoiceTransition(invoice.status, targetStatus);

  const now = new Date();
  const data: Prisma.MonthlyRevenueInvoiceUpdateInput = {
    status: targetStatus,
  };

  const shouldDistributeCommissions =
    invoice.status === INVOICE_STATUS.ACCRUED &&
    targetStatus === INVOICE_STATUS.INVOICED;
  const commissionChain = shouldDistributeCommissions
    ? await resolveCommissionChainForUser(prisma, invoice.userId)
    : [];

  if (targetStatus === INVOICE_STATUS.INVOICED) {
    const rate =
      opts?.usdInrRate != null && Number.isFinite(opts.usdInrRate) && opts.usdInrRate > 0
        ? opts.usdInrRate
        : await getUsdInrRate(prisma);
    const pinned = pinInrAmount(invoice.commissionAmount, rate);
    data.invoicedAt = now;
    data.dueDate = computeRevenueInvoiceDueDate(now);
    data.amountInr = pinned.amountInr;
    data.usdInrRate = pinned.usdInrRate;
  }

  if (targetStatus === INVOICE_STATUS.PAID) {
    data.paidAt = now;
    if (opts?.paymentReference?.trim()) {
      data.paymentReference = opts.paymentReference.trim();
    }
  }

  if (targetStatus === INVOICE_STATUS.VOID) {
    const reason = opts?.reason?.trim();
    if (!reason) {
      throw new InvoiceTransitionError(
        "reason is required when voiding an invoice",
      );
    }
    data.voidedAt = now;
    data.voidReason = reason;
  }

  return prisma.$transaction(async (tx) => {
    const updated = await tx.monthlyRevenueInvoice.update({
      where: { id: invoiceId },
      data,
    });

    if (
      invoice.status === INVOICE_STATUS.ACCRUED &&
      targetStatus === INVOICE_STATUS.INVOICED
    ) {
      await distributeMonthlyRevenueInvoiceCommissions(
        tx,
        {
          id: updated.id,
          userId: updated.userId,
          commissionAmount: updated.commissionAmount,
          isSimulated: updated.isSimulated,
          invoicedAt: now,
        },
        commissionChain,
      );
    }

    if (
      invoice.status === INVOICE_STATUS.INVOICED &&
      targetStatus === INVOICE_STATUS.PAID
    ) {
      await markMonthlyRevenueInvoiceCommissionsAsPayable(tx, updated.id);
    }

    if (targetStatus === INVOICE_STATUS.VOID) {
      await reverseMonthlyRevenueInvoiceCommissionsOnVoid(tx, {
        id: updated.id,
        userId: updated.userId,
        invoicedAt: updated.invoicedAt,
      });
    }

    return updated;
  });
}

export class CreditNoteError extends Error {
  readonly statusCode = 400;

  constructor(message: string) {
    super(message);
    this.name = "CreditNoteError";
  }
}

/**
 * Apply or update a credit note on a monthly invoice.
 * Does not change commissionAmount — reduces collectible amount only.
 */
export async function applyMonthlyRevenueInvoiceCreditNote(
  prisma: PrismaClient,
  invoiceId: string,
  args: { amount: Prisma.Decimal; reason: string },
): Promise<Prisma.MonthlyRevenueInvoiceGetPayload<object>> {
  const invoice = await prisma.monthlyRevenueInvoice.findUnique({
    where: { id: invoiceId },
  });
  if (!invoice) {
    throw new InvoiceNotFoundError(invoiceId);
  }

  if (
    invoice.status !== INVOICE_STATUS.INVOICED &&
    invoice.status !== INVOICE_STATUS.PAID
  ) {
    throw new CreditNoteError(
      `Credit notes apply only to INVOICED or PAID invoices (current: ${invoice.status})`,
    );
  }

  if (args.amount.lte(0)) {
    throw new CreditNoteError("Credit note amount must be positive");
  }
  if (args.amount.gt(invoice.commissionAmount)) {
    throw new CreditNoteError(
      "Credit note amount cannot exceed invoice commissionAmount",
    );
  }

  const reason = args.reason.trim();
  if (!reason) {
    throw new CreditNoteError("reason is required for a credit note");
  }

  return prisma.$transaction(async (tx) => {
    const updated = await tx.monthlyRevenueInvoice.update({
      where: { id: invoiceId },
      data: {
        creditNoteAmount: args.amount,
        creditNoteReason: reason,
      },
    });

    await reverseMonthlyRevenueInvoiceCommissionsForCreditNote(tx, {
      id: updated.id,
      userId: updated.userId,
      commissionAmount: updated.commissionAmount,
      creditNoteAmount: updated.creditNoteAmount ?? args.amount,
      invoicedAt: updated.invoicedAt,
    });

    return updated;
  });
}

export async function getMonthlyRevenueInvoiceLedger(
  prisma: PrismaClient,
  invoiceId: string,
) {
  const invoice = await prisma.monthlyRevenueInvoice.findUnique({
    where: { id: invoiceId },
    include: {
      user: { select: { id: true, email: true, name: true } },
    },
  });
  if (!invoice) return null;

  const commissions = await prisma.commissionLedger.findMany({
    where: { monthlyRevenueInvoiceId: invoiceId },
    include: {
      beneficiaryUser: { select: { id: true, email: true, name: true } },
    },
    orderBy: [{ createdAt: "asc" }, { beneficiaryUserId: "asc" }],
  });

  const collectibleAmount = invoice.commissionAmount.sub(
    invoice.creditNoteAmount ?? new Prisma.Decimal(0),
  );

  return {
    invoice: {
      id: invoice.id,
      userId: invoice.userId,
      userEmail: invoice.user.email,
      userName: invoice.user.name,
      periodYear: invoice.periodYear,
      periodMonth: invoice.periodMonth,
      status: invoice.status,
      commissionAmount: invoice.commissionAmount.toNumber(),
      creditNoteAmount: invoice.creditNoteAmount?.toNumber() ?? null,
      creditNoteReason: invoice.creditNoteReason ?? null,
      collectibleAmount: collectibleAmount.toNumber(),
      amountInr: invoice.amountInr?.toNumber() ?? null,
      invoicedAt: invoice.invoicedAt?.toISOString() ?? null,
      dueDate: invoice.dueDate?.toISOString() ?? null,
      paidAt: invoice.paidAt?.toISOString() ?? null,
      voidedAt: invoice.voidedAt?.toISOString() ?? null,
      voidReason: invoice.voidReason ?? null,
      paymentReference: invoice.paymentReference ?? null,
      isSimulated: invoice.isSimulated,
    },
    statusTimeline: [
      { status: "ACCRUED", at: invoice.generatedAt.toISOString() },
      ...(invoice.invoicedAt
        ? [{ status: "INVOICED", at: invoice.invoicedAt.toISOString() }]
        : []),
      ...(invoice.paidAt
        ? [{ status: "PAID", at: invoice.paidAt.toISOString() }]
        : []),
      ...(invoice.voidedAt
        ? [{ status: "VOID", at: invoice.voidedAt.toISOString(), reason: invoice.voidReason }]
        : []),
      ...(invoice.creditNoteAmount != null
        ? [
            {
              status: "CREDIT_NOTE",
              amount: invoice.creditNoteAmount.toNumber(),
              reason: invoice.creditNoteReason,
            },
          ]
        : []),
    ],
    commissionRows: commissions.map((row) => ({
      id: row.id,
      beneficiaryUserId: row.beneficiaryUserId,
      beneficiaryEmail: row.beneficiaryUser.email,
      beneficiaryName: row.beneficiaryUser.name,
      amount: row.amount,
      status: row.status,
      commissionRate: row.commissionRate,
      beneficiaryTier: row.beneficiaryTier,
      idempotencyKey: row.idempotencyKey,
      reversesLedgerId: row.reversesLedgerId,
      needsClawback: row.needsClawback,
      isSimulated: row.isSimulated,
      earnedAt: row.earnedAt.toISOString(),
      payableAt: row.payableAt?.toISOString() ?? null,
      withdrawableAt: row.withdrawableAt?.toISOString() ?? null,
      withdrawnAt: row.withdrawnAt?.toISOString() ?? null,
    })),
  };
}
