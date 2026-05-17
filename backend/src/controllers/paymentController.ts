import crypto from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import type { PrismaClient } from "@prisma/client";
import Razorpay from "razorpay";
import {
  creditWalletAfterGateway,
  settleInvoiceAfterGateway,
} from "../services/billingService.js";

const DEFAULT_CURRENCY = "INR";

function usdInrRate(): number {
  const raw = process.env.RAZORPAY_USD_INR_RATE ?? "83";
  const n = Number.parseFloat(raw);
  return Number.isFinite(n) && n > 0 ? n : 83;
}

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

export function createPaymentController(prisma: PrismaClient) {
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

      let amountInr: number;
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
        amountInr = Math.ceil(invoice.amountDue * usdInrRate());
        notes = {
          userId,
          purpose: "invoice",
          invoiceId,
          amountUsd: String(invoice.amountDue),
        };
      } else {
        const rawAmount = body.amount;
        if (typeof rawAmount !== "number" || !Number.isFinite(rawAmount) || rawAmount <= 0) {
          res.status(400).json({ error: "amount must be a positive number (INR)" });
          return;
        }
        amountInr = Math.ceil(rawAmount);
        notes = {
          userId,
          purpose: "wallet",
          amountInr: String(amountInr),
        };
      }

      if (amountInr < 1) {
        res.status(400).json({ error: "Order amount must be at least ₹1" });
        return;
      }

      const razorpay = getRazorpay();
      const receipt = `tict_${purpose}_${userId.slice(0, 8)}_${Date.now()}`;
      const order = await razorpay.orders.create({
        amount: amountInr * 100,
        currency,
        receipt,
        notes,
      });

      res.status(200).json({
        orderId: order.id,
        amount: amountInr,
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

      const purpose = notes.purpose ?? "wallet";

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
        res.status(200).json({
          ok: true,
          purpose: "invoice",
          invoiceId: outcome.invoiceId,
          amountPaid: outcome.amountDue,
        });
        return;
      }

      const paidInr = Number(order.amount) / 100;
      const amountUsd = paidInr / usdInrRate();
      const credit = await creditWalletAfterGateway(prisma, {
        userId,
        amountUsd,
      });
      if (!credit.ok) {
        res.status(credit.status).json({ error: credit.message });
        return;
      }

      res.status(200).json({
        ok: true,
        purpose: "wallet",
        amountCreditedUsd: credit.amountCredited,
        walletBalance: credit.walletBalance,
      });
    } catch (err) {
      next(err);
    }
  }

  return { createOrder, verifyPayment };
}
