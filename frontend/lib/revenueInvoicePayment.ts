import { authFetch } from "@/lib/authFetch";
import { COMPANY } from "@/lib/company";
import { openRazorpayCheckout } from "@/lib/razorpay";
import type { RevenueInvoiceRow } from "@/lib/revenueInvoiceTypes";
import { formatIstMonthYear } from "@/lib/istDates";

export function revenueInvoicePeriodLabel(inv: RevenueInvoiceRow): string {
  return formatIstMonthYear(inv.periodMonth, inv.periodYear);
}

export function revenueInvoiceCollectibleInr(inv: RevenueInvoiceRow): number | null {
  if (inv.collectibleAmount <= 0) return 0;
  if (inv.amountInr != null && inv.commissionAmount > 0) {
    return Math.round(inv.amountInr * (inv.collectibleAmount / inv.commissionAmount));
  }
  if (inv.usdInrRate != null && inv.usdInrRate > 0) {
    return Math.ceil(inv.collectibleAmount * inv.usdInrRate);
  }
  return null;
}

export function isRevenueInvoicePayable(inv: RevenueInvoiceRow): boolean {
  return inv.status === "INVOICED" && inv.collectibleAmount > 0;
}

export async function payRevenueInvoiceFromWallet(
  invoice: RevenueInvoiceRow,
): Promise<void> {
  const res = await authFetch(`/billing/pay-revenue-invoice/${invoice.id}`, {
    method: "POST",
  });
  const data = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) {
    throw new Error(data.error ?? "Payment failed");
  }
}

export async function payRevenueInvoiceWithRazorpay(
  invoice: RevenueInvoiceRow,
): Promise<void> {
  const orderRes = await authFetch("/payments/create-order", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      purpose: "revenue_invoice",
      revenueInvoiceId: invoice.id,
      currency: "INR",
    }),
  });
  const orderData = (await orderRes.json().catch(() => ({}))) as {
    error?: string;
    orderId?: string;
    keyId?: string;
    amount?: number;
    currency?: string;
  };
  if (!orderRes.ok) {
    throw new Error(orderData.error ?? "Could not start payment");
  }

  const description = `Revenue share — ${revenueInvoicePeriodLabel(invoice)}`;

  await new Promise<void>((resolve, reject) => {
    void openRazorpayCheckout({
      keyId: orderData.keyId ?? "",
      orderId: orderData.orderId ?? "",
      amountInr: orderData.amount ?? 0,
      currency: orderData.currency ?? "INR",
      name: COMPANY.legalName,
      description,
      onSuccess: async (rzpResponse) => {
        try {
          const verifyRes = await authFetch("/payments/verify", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(rzpResponse),
          });
          const verifyBody = (await verifyRes.json().catch(() => ({}))) as {
            error?: string;
          };
          if (!verifyRes.ok) {
            throw new Error(verifyBody.error ?? "Payment verification failed");
          }
          resolve();
        } catch (err) {
          reject(err);
        }
      },
      onDismiss: () => reject(new Error("Payment cancelled")),
    });
  });
}
