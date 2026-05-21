"use client";

import { openRazorpayCheckout } from "@/lib/razorpay";
import { Loader2, Tag } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

const ENV_API_BASE = process.env.NEXT_PUBLIC_API_URL?.trim().replace(/\/$/, "") ?? "";
function resolveApiBase(): string {
  if (ENV_API_BASE) return ENV_API_BASE;
  if (typeof window !== "undefined") {
    return `${window.location.origin.replace(/\/$/, "")}/api`;
  }
  return "";
}

type Props = {
  strategyId: string;
  strategyTitle: string;
  monthlyFeeInr: number;
  onSubscribed?: () => void;
  className?: string;
};

export function StrategySubscriptionCheckout({
  strategyId,
  strategyTitle,
  monthlyFeeInr,
  onSubscribed,
  className = "",
}: Props) {
  const apiBase = useMemo(resolveApiBase, []);
  const [couponInput, setCouponInput] = useState("");
  const [appliedCoupon, setAppliedCoupon] = useState<string | null>(null);
  const [quote, setQuote] = useState<{
    originalFeeInr: number;
    discountAmountInr: number;
    finalFeeInr: number;
    discountPercentage: number | null;
  } | null>(null);
  const [couponError, setCouponError] = useState<string | null>(null);
  const [applyBusy, setApplyBusy] = useState(false);
  const [payBusy, setPayBusy] = useState(false);
  const [pgFeePercent, setPgFeePercent] = useState(2.36);

  const token =
    typeof window !== "undefined" ? localStorage.getItem("token") ?? "" : "";

  const displayOriginal = quote?.originalFeeInr ?? monthlyFeeInr;
  const displayFinal = quote?.finalFeeInr ?? monthlyFeeInr;
  const requiresPayment = displayFinal > 0;

  const totalWithPg = useMemo(() => {
    if (!requiresPayment) return 0;
    const fee = (displayFinal * pgFeePercent) / 100;
    return Math.ceil(displayFinal + fee);
  }, [displayFinal, pgFeePercent, requiresPayment]);

  const loadPgFee = useCallback(async () => {
    try {
      const res = await fetch(`${apiBase}/payments/pg-fee`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.ok) {
        const data = (await res.json()) as { pgFeePercent?: number };
        if (typeof data.pgFeePercent === "number") {
          setPgFeePercent(data.pgFeePercent);
        }
      }
    } catch {
      /* optional */
    }
  }, [apiBase, token]);

  useEffect(() => {
    void loadPgFee();
  }, [loadPgFee]);

  async function applyCoupon() {
    setApplyBusy(true);
    setCouponError(null);
    try {
      const res = await fetch(`${apiBase}/subscriptions/coupons/validate`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          strategyId,
          couponCode: couponInput.trim(),
        }),
      });
      const body = (await res.json().catch(() => ({}))) as {
        error?: string;
        originalFeeInr?: number;
        discountAmountInr?: number;
        finalFeeInr?: number;
        discountPercentage?: number;
        couponCode?: string;
      };
      if (!res.ok) throw new Error(body.error ?? "Invalid coupon");
      setQuote({
        originalFeeInr: body.originalFeeInr ?? monthlyFeeInr,
        discountAmountInr: body.discountAmountInr ?? 0,
        finalFeeInr: body.finalFeeInr ?? monthlyFeeInr,
        discountPercentage: body.discountPercentage ?? null,
      });
      setAppliedCoupon(body.couponCode ?? couponInput.trim().toUpperCase());
    } catch (e) {
      setQuote(null);
      setAppliedCoupon(null);
      setCouponError(e instanceof Error ? e.message : "Could not apply coupon");
    } finally {
      setApplyBusy(false);
    }
  }

  async function subscribeFree() {
    setPayBusy(true);
    try {
      const res = await fetch(`${apiBase}/subscriptions/subscribe`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          strategyId,
          ...(appliedCoupon ? { couponCode: appliedCoupon } : {}),
        }),
      });
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(body.error ?? "Subscribe failed");
      onSubscribed?.();
    } catch (e) {
      setCouponError(e instanceof Error ? e.message : "Subscribe failed");
    } finally {
      setPayBusy(false);
    }
  }

  async function payAndSubscribe() {
    setPayBusy(true);
    setCouponError(null);
    try {
      const orderRes = await fetch(`${apiBase}/payments/create-order`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          purpose: "strategy_subscription",
          strategyId,
          currency: "INR",
          ...(appliedCoupon ? { couponCode: appliedCoupon } : {}),
        }),
      });
      const orderBody = (await orderRes.json().catch(() => ({}))) as {
        error?: string;
        orderId?: string;
        keyId?: string;
        amount?: number;
        baseAmount?: number;
        feeAmount?: number;
      };
      if (!orderRes.ok) throw new Error(orderBody.error ?? "Could not start payment");

      await new Promise<void>((resolve, reject) => {
        void openRazorpayCheckout({
          keyId: orderBody.keyId ?? "",
          orderId: orderBody.orderId ?? "",
          amountInr: orderBody.amount ?? 0,
          currency: "INR",
          name: "TradeICT Earner",
          description: `Subscribe: ${strategyTitle}`,
          onSuccess: async (response) => {
            try {
              const verifyRes = await fetch(`${apiBase}/payments/verify`, {
                method: "POST",
                headers: {
                  "Content-Type": "application/json",
                  Authorization: `Bearer ${token}`,
                },
                body: JSON.stringify(response),
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

      onSubscribed?.();
    } catch (e) {
      setCouponError(e instanceof Error ? e.message : "Payment failed");
    } finally {
      setPayBusy(false);
    }
  }

  return (
    <div
      className={`rounded-xl border border-gray-800 bg-gray-950 p-5 text-gray-100 ${className}`}
    >
      <h3 className="text-sm font-semibold text-gray-200">Subscription checkout</h3>
      <p className="mt-1 text-xs text-gray-500">
        Monthly fee for {strategyTitle}
      </p>

      <div className="mt-4 space-y-1 text-sm">
        <div className="flex justify-between text-gray-400">
          <span>Original fee</span>
          <span className="tabular-nums">₹{displayOriginal.toLocaleString("en-IN")}</span>
        </div>
        {quote && quote.discountAmountInr > 0 ? (
          <div className="flex justify-between text-emerald-400">
            <span>Discount ({quote.discountPercentage}%)</span>
            <span className="tabular-nums">
              −₹{quote.discountAmountInr.toLocaleString("en-IN")}
            </span>
          </div>
        ) : null}
        <div className="flex justify-between font-medium text-gray-100">
          <span>Amount due</span>
          <span className="tabular-nums">₹{displayFinal.toLocaleString("en-IN")}</span>
        </div>
        {requiresPayment && pgFeePercent > 0 ? (
          <div className="flex justify-between text-xs text-gray-500">
            <span>+ Razorpay fee ({pgFeePercent}%)</span>
            <span className="tabular-nums">
              ≈ ₹{totalWithPg.toLocaleString("en-IN")} total
            </span>
          </div>
        ) : null}
      </div>

      <div className="mt-4 flex gap-2">
        <div className="relative flex-1">
          <Tag className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-500" />
          <input
            type="text"
            value={couponInput}
            onChange={(e) => setCouponInput(e.target.value.toUpperCase())}
            placeholder="Discount coupon"
            className="w-full rounded-lg border border-gray-700 bg-gray-900 py-2.5 pl-9 pr-3 text-sm uppercase text-gray-100 placeholder:text-gray-600"
          />
        </div>
        <button
          type="button"
          disabled={applyBusy || !couponInput.trim()}
          onClick={() => void applyCoupon()}
          className="rounded-lg border border-gray-600 bg-gray-800 px-4 py-2.5 text-sm font-medium text-gray-100 hover:bg-gray-700 disabled:opacity-50"
        >
          {applyBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : "Apply"}
        </button>
      </div>
      {appliedCoupon ? (
        <p className="mt-2 text-xs text-emerald-400">Applied: {appliedCoupon}</p>
      ) : null}
      {couponError ? (
        <p className="mt-2 text-xs text-red-400">{couponError}</p>
      ) : null}

      <button
        type="button"
        disabled={payBusy}
        onClick={() =>
          void (requiresPayment ? payAndSubscribe() : subscribeFree())
        }
        className="mt-5 w-full rounded-lg bg-primary py-3 text-sm font-semibold text-white hover:bg-primary/90 disabled:opacity-60"
      >
        {payBusy ? (
          <Loader2 className="mx-auto h-5 w-5 animate-spin" />
        ) : requiresPayment ? (
          `Pay ₹${totalWithPg.toLocaleString("en-IN")} & Subscribe`
        ) : (
          "Subscribe (Free)"
        )}
      </button>
    </div>
  );
}
