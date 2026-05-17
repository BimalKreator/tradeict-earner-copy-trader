import crypto from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import { TransactionStatus, type PrismaClient } from "@prisma/client";
import Razorpay from "razorpay";
import {
  creditWalletAfterGateway,
  settleInvoiceAfterGateway,
} from "../services/billingService.js";
import {
  calculateFeeBreakdown,
  inrToUsd,
  roundInr,
  usdInrRate,
  type PaymentMethodKind,
} from "../services/paymentFeeService.js";
import { getPgFeePercent } from "../services/settingsService.js";
import { sendPaymentReceiptEmails } from "../utils/emailService.js";

const DEFAULT_CURRENCY = "INR";

function getRazorpay(): Razorpay {
  const keyId = process.env.RAZORPAY_KEY_ID?.trim();
  const keySecret = process.env.RAZORPAY_KEY_SECRET?.trim();
  if (!keyId || !keySecret) {
    throw new Error("RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET must be set");
  }
  return new Razorpay({ key_id: keyId, key_secret: keySecret });
}

function verifyRazorpaySignature(
  orderId: string,
  paymentId: string,
  signature: string,
): boolean {
  const secret = process.env.RAZORPAY_KEY_SECRET?.trim();
  if (!secret) return false;
  const body = `${orderId}|${paymentId}`;
  const expected = crypto
    .createHmac("sha256", secret)
    .update(body)
    .digest("hex");
  try {
    return crypto.timingSafeEqual(
      Buffer.from(expected, "utf8"),
      Buffer.from(signature, "utf8"),
    );
  } catch {
    return false;
  }
}

function parseDateRange(query: Record<string, unknown>): {
  start?: Date;
  end?: Date;
} {
  const start =
    typeof query.startDate === "string" && query.startDate
      ? new Date(query.startDate)
      : undefined;
  const end =
    typeof query.endDate === "string" && query.endDate
      ? new Date(query.endDate)
      : undefined;
  if (start && Number.isNaN(start.getTime())) return {};
  if (end && Number.isNaN(end.getTime())) return {};
  if (end) {
    end.setHours(23, 59, 59, 999);
  }
  const out: { start?: Date; end?: Date } = {};
  if (start) out.start = start;
  if (end) out.end = end;
  return out;
}

function serializePayment(row: {
  id: string;
  method: string;
  baseAmountInr: number;
  feeAmountInr: number;
  totalAmountInr: number;
  netCreditUsd: number;
  referenceId: string | null;
  status: TransactionStatus;
  createdAt: Date;
}) {
  return {
    id: row.id,
    date: row.createdAt.toISOString(),
    method: row.method,
    amount: row.baseAmountInr,
    fee: row.feeAmountInr,
    netCredit: row.netCreditUsd,
    totalInr: row.totalAmountInr,
    status: row.status,
    referenceId: row.referenceId,
  };
}

export function createPaymentController(prisma: PrismaClient) {
  async function getPgFee(
    _req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      const pgFeePercent = await getPgFeePercent(prisma);
      res.json({ pgFeePercent });
    } catch (err) {
      next(err);
    }
  }

  async function createOrder(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      const userId = req.userId;
      if (!userId) {
        res.status(401).json({ error: "Unauthorized" });
        return;
      }

      const body = req.body as Record<string, unknown>;
      const currency =
        typeof body.currency === "string" && body.currency.trim()
          ? body.currency.trim().toUpperCase()
          : DEFAULT_CURRENCY;

      const invoiceId =
        typeof body.invoiceId === "string" ? body.invoiceId.trim() : "";
      const purposeRaw =
        typeof body.purpose === "string" ? body.purpose.trim() : "";
      const purpose =
        purposeRaw === "invoice" || purposeRaw === "wallet"
          ? purposeRaw
          : invoiceId
            ? "invoice"
            : "wallet";

      const pgFeePercent = await getPgFeePercent(prisma);
      let breakdown;
      let notes: Record<string, string>;

      if (purpose === "invoice") {
        if (!invoiceId) {
          res.status(400).json({ error: "invoiceId is required for invoice payments" });
          return;
        }
        const invoice = await prisma.invoice.findUnique({
          where: { id: invoiceId },
        });
        if (!invoice || invoice.userId !== userId) {
          res.status(404).json({ error: "Invoice not found" });
          return;
        }
        if (invoice.status === "PAID") {
          res.status(409).json({ error: "Invoice already paid" });
          return;
        }
        const baseInr = Math.ceil(invoice.amountDue * (Number(process.env.RAZORPAY_USD_INR_RATE) || 83));
        breakdown = calculateFeeBreakdown(baseInr, pgFeePercent, "RAZORPAY");
        notes = {
          userId,
          purpose: "invoice",
          invoiceId,
          amountUsd: String(invoice.amountDue),
          baseAmountInr: String(breakdown.baseAmountInr),
          feeAmountInr: String(breakdown.feeAmountInr),
          totalAmountInr: String(breakdown.totalAmountInr),
        };
      } else {
        const rawBase = body.baseAmount ?? body.amount;
        const baseAmount =
          typeof rawBase === "number"
            ? rawBase
            : typeof rawBase === "string"
              ? Number.parseFloat(rawBase)
              : NaN;
        if (!Number.isFinite(baseAmount) || baseAmount <= 0) {
          res.status(400).json({
            error: "baseAmount must be a positive number (INR)",
          });
          return;
        }
        breakdown = calculateFeeBreakdown(baseAmount, pgFeePercent, "RAZORPAY");
        notes = {
          userId,
          purpose: "wallet",
          baseAmountInr: String(breakdown.baseAmountInr),
          feeAmountInr: String(breakdown.feeAmountInr),
          totalAmountInr: String(breakdown.totalAmountInr),
        };
      }

      const totalInr = Math.ceil(breakdown.totalAmountInr);
      if (totalInr < 1) {
        res.status(400).json({ error: "Order amount must be at least ₹1" });
        return;
      }

      const razorpay = getRazorpay();
      const receipt = `tict_${purpose}_${userId.slice(0, 8)}_${Date.now()}`;
      const order = await razorpay.orders.create({
        amount: totalInr * 100,
        currency,
        receipt,
        notes,
      });

      res.status(200).json({
        orderId: order.id,
        baseAmount: breakdown.baseAmountInr,
        feeAmount: breakdown.feeAmountInr,
        amount: totalInr,
        totalPayable: totalInr,
        pgFeePercent,
        currency: order.currency,
        keyId: process.env.RAZORPAY_KEY_ID,
        purpose,
        invoiceId: invoiceId || undefined,
      });
    } catch (err) {
      next(err);
    }
  }

  async function verifyPayment(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      const userId = req.userId;
      if (!userId) {
        res.status(401).json({ error: "Unauthorized" });
        return;
      }

      const body = req.body as Record<string, unknown>;
      const orderId =
        typeof body.razorpay_order_id === "string"
          ? body.razorpay_order_id.trim()
          : "";
      const paymentId =
        typeof body.razorpay_payment_id === "string"
          ? body.razorpay_payment_id.trim()
          : "";
      const signature =
        typeof body.razorpay_signature === "string"
          ? body.razorpay_signature.trim()
          : "";

      if (!orderId || !paymentId || !signature) {
        res.status(400).json({
          error:
            "razorpay_order_id, razorpay_payment_id, and razorpay_signature are required",
        });
        return;
      }

      const existing = await prisma.paymentTransaction.findUnique({
        where: { razorpayPaymentId: paymentId },
      });
      if (existing?.status === TransactionStatus.APPROVED) {
        res.status(200).json({ ok: true, alreadyProcessed: true });
        return;
      }

      if (!verifyRazorpaySignature(orderId, paymentId, signature)) {
        res.status(400).json({ error: "Invalid payment signature" });
        return;
      }

      const razorpay = getRazorpay();
      const order = await razorpay.orders.fetch(orderId);
      const notes = (order.notes ?? {}) as Record<string, string>;
      if (notes.userId !== userId) {
        res.status(403).json({ error: "Order does not belong to this user" });
        return;
      }

      const baseAmountInr = roundInr(
        Number.parseFloat(notes.baseAmountInr ?? "0") ||
          Number(order.amount) / 100,
      );
      const feeAmountInr = roundInr(Number.parseFloat(notes.feeAmountInr ?? "0"));
      const totalAmountInr = roundInr(
        Number.parseFloat(notes.totalAmountInr ?? "0") ||
          Number(order.amount) / 100,
      );
      const netCreditUsd = inrToUsd(baseAmountInr);
      const purpose = notes.purpose ?? "wallet";

      const user = await prisma.user.findUnique({
        where: { id: userId },
        select: { id: true, email: true, name: true },
      });
      if (!user) {
        res.status(404).json({ error: "User not found" });
        return;
      }

      if (purpose === "invoice") {
        const invoiceId = notes.invoiceId?.trim();
        if (!invoiceId) {
          res.status(400).json({ error: "Invoice reference missing on order" });
          return;
        }
        const outcome = await settleInvoiceAfterGateway(prisma, {
          userId,
          invoiceId,
        });
        if (!outcome.ok) {
          res.status(outcome.status).json({ error: outcome.message });
          return;
        }

        await prisma.paymentTransaction.create({
          data: {
            userId,
            method: "RAZORPAY",
            baseAmountInr,
            feeAmountInr,
            totalAmountInr,
            netCreditUsd: outcome.amountDue,
            referenceId: paymentId,
            razorpayOrderId: orderId,
            razorpayPaymentId: paymentId,
            status: TransactionStatus.APPROVED,
          },
        });

        void sendPaymentReceiptEmails({
          userName: user.name ?? user.email,
          userEmail: user.email,
          method: "RAZORPAY (Invoice)",
          baseAmountInr,
          feeAmountInr,
          totalAmountInr,
          netCreditUsd: outcome.amountDue,
          referenceId: paymentId,
        }).catch(() => {});

        res.status(200).json({
          ok: true,
          purpose: "invoice",
          invoiceId: outcome.invoiceId,
          amountPaid: outcome.amountDue,
        });
        return;
      }

      const credit = await creditWalletAfterGateway(prisma, {
        userId,
        amountUsd: netCreditUsd,
      });
      if (!credit.ok) {
        res.status(credit.status).json({ error: credit.message });
        return;
      }

      await prisma.paymentTransaction.create({
        data: {
          userId,
          method: "RAZORPAY",
          baseAmountInr,
          feeAmountInr,
          totalAmountInr,
          netCreditUsd,
          referenceId: paymentId,
          razorpayOrderId: orderId,
          razorpayPaymentId: paymentId,
          status: TransactionStatus.APPROVED,
        },
      });

      void sendPaymentReceiptEmails({
        userName: user.name ?? user.email,
        userEmail: user.email,
        method: "RAZORPAY",
        baseAmountInr,
        feeAmountInr,
        totalAmountInr,
        netCreditUsd,
        referenceId: paymentId,
      }).catch(() => {});

      res.status(200).json({
        ok: true,
        purpose: "wallet",
        amountCreditedUsd: credit.amountCredited,
        walletBalance: credit.walletBalance,
        baseAmountInr,
        feeAmountInr,
        totalAmountInr,
      });
    } catch (err) {
      next(err);
    }
  }

  async function manualDeposit(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      const userId = req.userId;
      if (!userId) {
        res.status(401).json({ error: "Unauthorized" });
        return;
      }

      const body = req.body as Record<string, unknown>;
      const amount = Number(body.amount);
      const methodRaw =
        typeof body.method === "string" ? body.method.trim().toUpperCase() : "";
      const transactionId = String(body.transactionId ?? "").trim();

      if (!Number.isFinite(amount) || amount <= 0) {
        res.status(400).json({ error: "amount must be a positive number" });
        return;
      }
      if (methodRaw !== "UPI" && methodRaw !== "BANK") {
        res.status(400).json({ error: "method must be UPI or BANK" });
        return;
      }
      if (!transactionId) {
        res.status(400).json({ error: "transactionId is required" });
        return;
      }

      const method = methodRaw as PaymentMethodKind;
      const pgFeePercent = await getPgFeePercent(prisma);
      const breakdown = calculateFeeBreakdown(amount, pgFeePercent, method);
      const netCreditUsd = inrToUsd(breakdown.netBaseInr);

      const file = req.file as { filename?: string } | undefined;
      const screenshotUrl = file?.filename ? `/uploads/${file.filename}` : null;

      const result = await prisma.$transaction(async (tx) => {
        const deposit = await tx.depositRequest.create({
          data: {
            userId,
            amount: breakdown.baseAmountInr,
            method: methodRaw,
            baseAmountInr: breakdown.baseAmountInr,
            feeAmountInr: breakdown.feeAmountInr,
            netCreditUsd,
            transactionId,
            screenshotUrl,
            status: "PENDING",
          },
        });

        const payment = await tx.paymentTransaction.create({
          data: {
            userId,
            method: methodRaw,
            baseAmountInr: breakdown.baseAmountInr,
            feeAmountInr: breakdown.feeAmountInr,
            totalAmountInr: breakdown.totalAmountInr,
            netCreditUsd,
            referenceId: transactionId,
            depositRequestId: deposit.id,
            status: TransactionStatus.PENDING,
          },
        });

        return { deposit, payment };
      });

      await prisma.notification.create({
        data: {
          userId: null,
          title: "New Manual Deposit",
          message: `User ${userId} submitted ${methodRaw} deposit ₹${breakdown.baseAmountInr} (UTR: ${transactionId}).`,
        },
      });

      res.status(201).json({
        id: result.payment.id,
        depositId: result.deposit.id,
        method: methodRaw,
        baseAmount: breakdown.baseAmountInr,
        feeAmount: breakdown.feeAmountInr,
        netCreditUsd,
        pgFeePercent,
        status: "PENDING",
      });
    } catch (err) {
      next(err);
    }
  }

  async function listHistory(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      const userId = req.userId;
      if (!userId) {
        res.status(401).json({ error: "Unauthorized" });
        return;
      }

      const { start, end } = parseDateRange(req.query as Record<string, unknown>);
      const rows = await prisma.paymentTransaction.findMany({
        where: {
          userId,
          ...(start || end
            ? {
                createdAt: {
                  ...(start ? { gte: start } : {}),
                  ...(end ? { lte: end } : {}),
                },
              }
            : {}),
        },
        orderBy: { createdAt: "desc" },
      });

      res.json({
        transactions: rows.map(serializePayment),
        pgFeePercent: await getPgFeePercent(prisma),
        usdInrRate: usdInrRate(),
      });
    } catch (err) {
      next(err);
    }
  }

  async function exportHistory(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      const userId = req.userId;
      if (!userId) {
        res.status(401).json({ error: "Unauthorized" });
        return;
      }

      const { start, end } = parseDateRange(req.query as Record<string, unknown>);
      const rows = await prisma.paymentTransaction.findMany({
        where: {
          userId,
          ...(start || end
            ? {
                createdAt: {
                  ...(start ? { gte: start } : {}),
                  ...(end ? { lte: end } : {}),
                },
              }
            : {}),
        },
        orderBy: { createdAt: "desc" },
      });

      const header =
        "Date,Method,Amount (INR),Fee (INR),Net Credit (USD),Status,Reference\n";
      const lines = rows.map((r: (typeof rows)[number]) => {
        const cols = [
          r.createdAt.toISOString(),
          r.method,
          r.baseAmountInr.toFixed(2),
          r.feeAmountInr.toFixed(2),
          r.netCreditUsd.toFixed(2),
          r.status,
          (r.referenceId ?? "").replace(/,/g, " "),
        ];
        return cols.join(",");
      });

      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="payments_${Date.now()}.csv"`,
      );
      res.send(header + lines.join("\n"));
    } catch (err) {
      next(err);
    }
  }

  return {
    getPgFee,
    createOrder,
    verifyPayment,
    manualDeposit,
    listHistory,
    exportHistory,
  };
}
