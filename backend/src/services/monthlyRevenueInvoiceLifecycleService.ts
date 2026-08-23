import { Prisma, type PrismaClient } from "@prisma/client";
import { roundInr, usdToInr } from "./paymentFeeService.js";
import { getUsdInrRate } from "./settingsService.js";
import {
  distributeMonthlyRevenueInvoiceCommissions,
  markMonthlyRevenueInvoiceCommissionsAsPayable,
  resolveCommissionChainForUser,
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

    return updated;
  });
}
