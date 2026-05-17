"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Building2,
  Copy,
  CreditCard,
  Download,
  Loader2,
  QrCode,
} from "lucide-react";
import { COMPANY } from "@/lib/company";
import { openRazorpayCheckout } from "@/lib/razorpay";

const API_BASE =
  process.env.NEXT_PUBLIC_API_URL?.trim().replace(/\/$/, "") ?? "";

type TabId = "razorpay" | "upi" | "bank";

type PaymentRow = {
  id: string;
  date: string;
  method: string;
  amount: number;
  fee: number;
  netCredit: number;
  totalInr: number;
  status: string;
  referenceId: string | null;
};

const upiQrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=220x220&data=${encodeURIComponent(
  `upi://pay?pa=${COMPANY.razorpayUpiId}&pn=${encodeURIComponent(COMPANY.legalName)}`,
)}`;

const inrFmt = new Intl.NumberFormat("en-IN", {
  style: "currency",
  currency: "INR",
  minimumFractionDigits: 2,
});

const usdFmt = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
});

function calcFee(base: number, pgFeePercent: number, method: "RAZORPAY" | "UPI" | "BANK") {
  const b = Math.max(0, base);
  if (method === "BANK") {
    return { base: b, fee: 0, total: b, netBase: b };
  }
  const fee = Math.round((b * pgFeePercent) / 100 * 100) / 100;
  if (method === "UPI") {
    return { base: b, fee, total: b, netBase: Math.max(0, b - fee) };
  }
  return { base: b, fee, total: b + fee, netBase: b };
}

async function authFetch(path: string, init?: RequestInit): Promise<Response> {
  const token =
    typeof window !== "undefined" ? localStorage.getItem("token") : null;
  return fetch(`${API_BASE}${path}`, {
    ...init,
    headers: {
      ...(init?.headers ?? {}),
      Authorization: `Bearer ${token ?? ""}`,
    },
  });
}

const inputClass =
  "mt-2 w-full rounded-lg border border-glassBorder bg-black/40 px-4 py-3 text-sm text-white outline-none ring-primary/25 placeholder:text-white/30 focus:ring-2 disabled:opacity-50";

export default function DashboardPaymentsPage() {
  const [tab, setTab] = useState<TabId>("razorpay");
  const [pgFeePercent, setPgFeePercent] = useState(2.36);
  const [loadingFee, setLoadingFee] = useState(true);

  const [baseInr, setBaseInr] = useState("");
  const [razorpayLoading, setRazorpayLoading] = useState(false);

  const [upiAmount, setUpiAmount] = useState("");
  const [upiTxnId, setUpiTxnId] = useState("");
  const [upiScreenshot, setUpiScreenshot] = useState<File | null>(null);

  const [bankAmount, setBankAmount] = useState("");
  const [bankTxnId, setBankTxnId] = useState("");
  const [bankScreenshot, setBankScreenshot] = useState<File | null>(null);

  const [manualLoading, setManualLoading] = useState(false);
  const [copiedUpi, setCopiedUpi] = useState(false);

  const [history, setHistory] = useState<PaymentRow[]>([]);
  const [historyLoading, setHistoryLoading] = useState(true);
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");
  const [downloading, setDownloading] = useState(false);

  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const razorpayBreakdown = useMemo(() => {
    const n = Number.parseFloat(baseInr);
    if (!Number.isFinite(n) || n <= 0) return null;
    return calcFee(n, pgFeePercent, "RAZORPAY");
  }, [baseInr, pgFeePercent]);

  const upiBreakdown = useMemo(() => {
    const n = Number.parseFloat(upiAmount);
    if (!Number.isFinite(n) || n <= 0) return null;
    return calcFee(n, pgFeePercent, "UPI");
  }, [upiAmount, pgFeePercent]);

  const loadFee = useCallback(async () => {
    setLoadingFee(true);
    try {
      const res = await authFetch("/payments/pg-fee");
      if (res.ok) {
        const data = (await res.json()) as { pgFeePercent?: number };
        if (typeof data.pgFeePercent === "number") {
          setPgFeePercent(data.pgFeePercent);
        }
      }
    } finally {
      setLoadingFee(false);
    }
  }, []);

  const loadHistory = useCallback(async () => {
    setHistoryLoading(true);
    try {
      const qs = new URLSearchParams();
      if (fromDate) qs.set("startDate", fromDate);
      if (toDate) qs.set("endDate", toDate);
      const suffix = qs.toString() ? `?${qs.toString()}` : "";
      const res = await authFetch(`/payments/history${suffix}`);
      if (!res.ok) throw new Error(`Failed to load history (${res.status})`);
      const data = (await res.json()) as {
        transactions?: PaymentRow[];
        pgFeePercent?: number;
      };
      setHistory(Array.isArray(data.transactions) ? data.transactions : []);
      if (typeof data.pgFeePercent === "number") setPgFeePercent(data.pgFeePercent);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load transactions");
    } finally {
      setHistoryLoading(false);
    }
  }, [fromDate, toDate]);

  useEffect(() => {
    void loadFee();
    void loadHistory();
  }, [loadFee, loadHistory]);

  useEffect(() => {
    if (!success) return;
    const t = setTimeout(() => setSuccess(null), 5000);
    return () => clearTimeout(t);
  }, [success]);

  async function handleRazorpayPay() {
    setError(null);
    setSuccess(null);
    const base = Number.parseFloat(baseInr);
    if (!Number.isFinite(base) || base < 1) {
      setError("Enter a valid base amount in INR (minimum ₹1).");
      return;
    }
    setRazorpayLoading(true);
    try {
      const res = await authFetch("/payments/create-order", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          baseAmount: base,
          purpose: "wallet",
          currency: "INR",
        }),
      });
      const data: unknown = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(
          typeof data === "object" && data && "error" in data
            ? String((data as { error: string }).error)
            : `Order failed (${res.status})`,
        );
      }
      const order = data as {
        orderId: string;
        keyId: string;
        amount: number;
        currency: string;
      };

      await new Promise<void>((resolve, reject) => {
        void openRazorpayCheckout({
          keyId: order.keyId,
          orderId: order.orderId,
          amountInr: order.amount,
          currency: order.currency,
          name: COMPANY.legalName,
          description: "Wallet top-up — TradeICT Earner",
          onSuccess: async (rzp) => {
            try {
              const verifyRes = await authFetch("/payments/verify", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(rzp),
              });
              const verifyBody: unknown = await verifyRes.json().catch(() => ({}));
              if (!verifyRes.ok) {
                throw new Error(
                  typeof verifyBody === "object" && verifyBody && "error" in verifyBody
                    ? String((verifyBody as { error: string }).error)
                    : "Verification failed",
                );
              }
              setSuccess("Payment successful! Your wallet has been credited.");
              setBaseInr("");
              await loadHistory();
              resolve();
            } catch (e) {
              reject(e);
            }
          },
          onDismiss: () => reject(new Error("Payment cancelled")),
        }).catch(reject);
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Payment failed";
      if (msg !== "Payment cancelled") setError(msg);
    } finally {
      setRazorpayLoading(false);
    }
  }

  async function submitManual(method: "UPI" | "BANK") {
    setError(null);
    setSuccess(null);
    const amount = Number.parseFloat(method === "UPI" ? upiAmount : bankAmount);
    const transactionId = (method === "UPI" ? upiTxnId : bankTxnId).trim();
    const screenshot = method === "UPI" ? upiScreenshot : bankScreenshot;

    if (!Number.isFinite(amount) || amount <= 0) {
      setError("Enter a valid deposit amount.");
      return;
    }
    if (!transactionId) {
      setError("Enter your UTR / transaction ID.");
      return;
    }

    setManualLoading(true);
    try {
      const fd = new FormData();
      fd.append("amount", String(amount));
      fd.append("method", method);
      fd.append("transactionId", transactionId);
      if (screenshot) fd.append("screenshot", screenshot);

      const res = await authFetch("/payments/manual-deposit", {
        method: "POST",
        body: fd,
      });
      const data: unknown = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(
          typeof data === "object" && data && "error" in data
            ? String((data as { error: string }).error)
            : `Submit failed (${res.status})`,
        );
      }

      setSuccess(
        "Deposit submitted. Manual payments are updated within 24 hours after verification.",
      );
      if (method === "UPI") {
        setUpiAmount("");
        setUpiTxnId("");
        setUpiScreenshot(null);
      } else {
        setBankAmount("");
        setBankTxnId("");
        setBankScreenshot(null);
      }
      await loadHistory();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not submit deposit");
    } finally {
      setManualLoading(false);
    }
  }

  async function copyUpi() {
    try {
      await navigator.clipboard.writeText(COMPANY.razorpayUpiId);
      setCopiedUpi(true);
      setTimeout(() => setCopiedUpi(false), 2000);
    } catch {
      setError("Could not copy UPI ID.");
    }
  }

  async function downloadCsv() {
    setDownloading(true);
    try {
      const qs = new URLSearchParams();
      if (fromDate) qs.set("startDate", fromDate);
      if (toDate) qs.set("endDate", toDate);
      const suffix = qs.toString() ? `?${qs.toString()}` : "";
      const res = await authFetch(`/payments/history/export${suffix}`);
      if (!res.ok) throw new Error(`Download failed (${res.status})`);
      const blob = await res.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `payments_${Date.now()}.csv`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      window.URL.revokeObjectURL(url);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Download failed");
    } finally {
      setDownloading(false);
    }
  }

  const tabs: { id: TabId; label: string; icon: typeof CreditCard }[] = [
    { id: "razorpay", label: "Instant (Razorpay)", icon: CreditCard },
    { id: "upi", label: "Manual UPI", icon: QrCode },
    { id: "bank", label: "Bank Transfer", icon: Building2 },
  ];

  return (
    <div className="space-y-8">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight text-white md:text-3xl">
          Payments
        </h1>
        <p className="mt-2 text-sm text-white/55">
          Top up your wallet via Razorpay, UPI, or bank transfer. Gateway fee:{" "}
          {loadingFee ? "…" : `${pgFeePercent}%`}
          {pgFeePercent > 0 ? " (UPI & Razorpay)" : ""}.
        </p>
      </header>

      {error && (
        <div className="rounded-lg border border-red-500/35 bg-red-500/10 px-4 py-3 text-sm text-red-200">
          {error}
        </div>
      )}
      {success && (
        <div className="rounded-lg border border-emerald-500/40 bg-emerald-500/10 px-4 py-3 text-sm text-emerald-100">
          {success}
        </div>
      )}

      <div className="glass-card border border-glassBorder overflow-hidden">
        <div className="flex flex-wrap gap-1 border-b border-glassBorder bg-white/[0.02] p-2">
          {tabs.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              type="button"
              onClick={() => setTab(id)}
              className={`inline-flex items-center gap-2 rounded-lg px-4 py-2.5 text-sm font-medium transition ${
                tab === id
                  ? "bg-primary/15 text-primary ring-1 ring-primary/40"
                  : "text-white/60 hover:bg-white/5 hover:text-white"
              }`}
            >
              <Icon className="h-4 w-4" aria-hidden />
              {label}
            </button>
          ))}
        </div>

        <div className="p-6 md:p-8">
          {tab === "razorpay" && (
            <div className="max-w-lg space-y-5">
              <p className="text-sm text-white/60">
                Pay instantly via card, UPI, or netbanking. You pay base amount +{" "}
                {pgFeePercent}% gateway fee; only the base amount is credited to your wallet.
              </p>
              <label className="block text-sm text-white/70">
                Base amount (INR)
                <input
                  type="number"
                  min={1}
                  step={1}
                  value={baseInr}
                  onChange={(e) => setBaseInr(e.target.value)}
                  disabled={razorpayLoading}
                  placeholder="e.g. 5000"
                  className={inputClass}
                />
              </label>
              {razorpayBreakdown && (
                <div className="rounded-xl border border-cyan-500/25 bg-cyan-500/5 p-4 text-sm space-y-2">
                  <div className="flex justify-between text-white/70">
                    <span>Base amount</span>
                    <span className="tabular-nums text-white">
                      {inrFmt.format(razorpayBreakdown.base)}
                    </span>
                  </div>
                  <div className="flex justify-between text-white/70">
                    <span>PG fee ({pgFeePercent}%)</span>
                    <span className="tabular-nums text-amber-200">
                      + {inrFmt.format(razorpayBreakdown.fee)}
                    </span>
                  </div>
                  <div className="flex justify-between border-t border-white/10 pt-2 font-semibold text-white">
                    <span>Total payable</span>
                    <span className="tabular-nums text-cyan-300">
                      {inrFmt.format(razorpayBreakdown.total)}
                    </span>
                  </div>
                </div>
              )}
              <button
                type="button"
                onClick={() => void handleRazorpayPay()}
                disabled={razorpayLoading || !razorpayBreakdown}
                className="inline-flex items-center gap-2 rounded-lg bg-cyan-600 px-6 py-3 text-sm font-semibold text-white shadow-lg shadow-cyan-500/25 hover:bg-cyan-500 disabled:opacity-50"
              >
                {razorpayLoading ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin" />
                    Processing…
                  </>
                ) : (
                  <>
                    <CreditCard className="h-4 w-4" />
                    Pay Now
                  </>
                )}
              </button>
            </div>
          )}

          {tab === "upi" && (
            <div className="grid gap-8 lg:grid-cols-2">
              <div className="space-y-4">
                <div className="inline-flex w-fit rounded-xl border border-white/10 bg-white p-3">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={upiQrUrl} alt="UPI QR" width={200} height={200} />
                </div>
                <div>
                  <p className="text-xs uppercase tracking-wider text-white/45">UPI ID</p>
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    <code className="rounded-lg border border-cyan-500/30 bg-cyan-500/10 px-3 py-2 text-sm text-cyan-100">
                      {COMPANY.razorpayUpiId}
                    </code>
                    <button
                      type="button"
                      onClick={() => void copyUpi()}
                      className="inline-flex items-center gap-1 rounded-lg border border-white/15 px-3 py-2 text-xs text-white/70 hover:bg-white/5"
                    >
                      <Copy className="h-3.5 w-3.5" />
                      {copiedUpi ? "Copied" : "Copy"}
                    </button>
                  </div>
                </div>
                <p className="rounded-lg border border-amber-500/25 bg-amber-500/10 px-3 py-2 text-sm text-amber-100/90">
                  A {pgFeePercent}% payment gateway fee will be deducted from your deposit
                  before crediting the wallet. Manual updates take up to 24 hours.
                </p>
                <p className="text-xs text-white/50">
                  Note: Please include the applicable Razorpay convenience fee in your total
                  amount when paying manually via QR or UPI.
                </p>
              </div>
              <ManualDepositForm
                amount={upiAmount}
                setAmount={setUpiAmount}
                txnId={upiTxnId}
                setTxnId={setUpiTxnId}
                screenshot={upiScreenshot}
                setScreenshot={setUpiScreenshot}
                breakdown={upiBreakdown}
                pgFeePercent={pgFeePercent}
                loading={manualLoading}
                onSubmit={() => void submitManual("UPI")}
              />
            </div>
          )}

          {tab === "bank" && (
            <div className="grid gap-8 lg:grid-cols-2">
              <div className="space-y-4">
                <p className="text-sm font-medium text-primary">Bank account details</p>
                <div className="grid gap-3">
                  <InfoRow label="Account name" value="TRADEICT AI PRIVATE LIMITED" />
                  <InfoRow label="Account no." value="28050200000684" />
                  <InfoRow label="IFSC" value="BARB0SAPRBS" />
                </div>
                <p className="rounded-lg border border-emerald-500/25 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-100/90">
                  0% gateway fee for direct bank transfers. Manual updates take up to 24 hours.
                </p>
              </div>
              <ManualDepositForm
                amount={bankAmount}
                setAmount={setBankAmount}
                txnId={bankTxnId}
                setTxnId={setBankTxnId}
                screenshot={bankScreenshot}
                setScreenshot={setBankScreenshot}
                breakdown={
                  Number.parseFloat(bankAmount) > 0
                    ? calcFee(Number.parseFloat(bankAmount), pgFeePercent, "BANK")
                    : null
                }
                pgFeePercent={0}
                loading={manualLoading}
                onSubmit={() => void submitManual("BANK")}
                zeroFee
              />
            </div>
          )}
        </div>
      </div>

      <section className="glass-card border border-glassBorder overflow-hidden">
        <div className="flex flex-col gap-4 border-b border-glassBorder bg-white/[0.03] px-5 py-4 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <h2 className="text-sm font-semibold text-white">Transaction history</h2>
            <p className="text-xs text-white/45">All Razorpay and manual deposits</p>
          </div>
          <div className="flex flex-wrap items-end gap-3">
            <label className="text-xs text-white/60">
              From
              <input
                type="date"
                value={fromDate}
                onChange={(e) => setFromDate(e.target.value)}
                className="mt-1 block rounded-lg border border-glassBorder bg-black/40 px-3 py-2 text-sm text-white"
              />
            </label>
            <label className="text-xs text-white/60">
              To
              <input
                type="date"
                value={toDate}
                onChange={(e) => setToDate(e.target.value)}
                className="mt-1 block rounded-lg border border-glassBorder bg-black/40 px-3 py-2 text-sm text-white"
              />
            </label>
            <button
              type="button"
              onClick={() => void loadHistory()}
              className="rounded-lg border border-white/15 px-3 py-2 text-xs text-white/80 hover:bg-white/5"
            >
              Apply
            </button>
            <button
              type="button"
              onClick={() => void downloadCsv()}
              disabled={downloading}
              className="inline-flex items-center gap-1.5 rounded-lg border border-cyan-500/40 bg-cyan-500/15 px-3 py-2 text-xs font-medium text-cyan-200 hover:bg-cyan-500/25 disabled:opacity-50"
            >
              <Download className="h-3.5 w-3.5" />
              {downloading ? "…" : "Download CSV"}
            </button>
          </div>
        </div>

        <div className="scroll-table overflow-x-auto">
          <table className="w-full min-w-[800px] text-left text-sm">
            <thead className="border-b border-glassBorder bg-white/[0.02] text-white/70">
              <tr>
                <th className="px-4 py-3 font-medium">Date</th>
                <th className="px-4 py-3 font-medium">Method</th>
                <th className="px-4 py-3 text-right font-medium">Amount</th>
                <th className="px-4 py-3 text-right font-medium">Fee</th>
                <th className="px-4 py-3 text-right font-medium">Net credit</th>
                <th className="px-4 py-3 font-medium">Status</th>
              </tr>
            </thead>
            <tbody>
              {historyLoading ? (
                <tr>
                  <td colSpan={6} className="px-4 py-12 text-center text-white/45">
                    <Loader2 className="mx-auto h-6 w-6 animate-spin text-primary" />
                  </td>
                </tr>
              ) : history.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-4 py-12 text-center text-white/45">
                    No transactions yet.
                  </td>
                </tr>
              ) : (
                history.map((r) => (
                  <tr
                    key={r.id}
                    className="border-b border-white/[0.06] last:border-0 hover:bg-white/[0.02]"
                  >
                    <td className="whitespace-nowrap px-4 py-3 text-white/70 tabular-nums">
                      {new Date(r.date).toLocaleString()}
                    </td>
                    <td className="px-4 py-3 text-white/80">{r.method}</td>
                    <td className="px-4 py-3 text-right tabular-nums text-white">
                      {inrFmt.format(r.amount)}
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums text-amber-200/90">
                      {inrFmt.format(r.fee)}
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums text-emerald-300">
                      {usdFmt.format(r.netCredit)}
                    </td>
                    <td className="px-4 py-3">
                      <StatusBadge status={r.status} />
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-glassBorder bg-white/[0.03] px-4 py-3">
      <p className="text-[11px] uppercase tracking-wider text-white/45">{label}</p>
      <p className="mt-1 text-sm font-medium text-white">{value}</p>
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const s = status.toUpperCase();
  const cls =
    s === "APPROVED"
      ? "bg-emerald-500/15 text-emerald-300"
      : s === "REJECTED"
        ? "bg-red-500/15 text-red-300"
        : "bg-amber-500/15 text-amber-200";
  return (
    <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${cls}`}>
      {s}
    </span>
  );
}

function ManualDepositForm({
  amount,
  setAmount,
  txnId,
  setTxnId,
  screenshot,
  setScreenshot,
  breakdown,
  pgFeePercent,
  loading,
  onSubmit,
  zeroFee,
}: {
  amount: string;
  setAmount: (v: string) => void;
  txnId: string;
  setTxnId: (v: string) => void;
  screenshot: File | null;
  setScreenshot: (f: File | null) => void;
  breakdown: ReturnType<typeof calcFee> | null;
  pgFeePercent: number;
  loading: boolean;
  onSubmit: () => void;
  zeroFee?: boolean;
}) {
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit();
      }}
      className="space-y-4"
    >
      <p className="text-sm font-medium text-white">Submit deposit details</p>
      <label className="block text-sm text-white/70">
        Amount (INR)
        <input
          type="number"
          min={1}
          required
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          disabled={loading}
          className={inputClass}
        />
      </label>
      {breakdown && !zeroFee && (
        <p className="text-xs text-white/55">
          Est. wallet credit after {pgFeePercent}% fee:{" "}
          <span className="text-emerald-300">{inrFmt.format(breakdown.netBase)}</span> → USD
          at live rate
        </p>
      )}
      <label className="block text-sm text-white/70">
        UTR / Transaction ID
        <input
          type="text"
          required
          value={txnId}
          onChange={(e) => setTxnId(e.target.value)}
          disabled={loading}
          className={inputClass}
        />
      </label>
      <label className="block text-sm text-white/70">
        Screenshot (optional)
        <input
          type="file"
          accept="image/*"
          onChange={(e) => setScreenshot(e.target.files?.[0] ?? null)}
          disabled={loading}
          className={`${inputClass} file:mr-3 file:rounded-md file:border-0 file:bg-primary/20 file:px-3 file:py-1.5 file:text-white`}
        />
      </label>
      <button
        type="submit"
        disabled={loading}
        className="w-full rounded-lg bg-primary py-3 text-sm font-medium text-white hover:bg-primary/90 disabled:opacity-50"
      >
        {loading ? "Submitting…" : "Submit deposit details"}
      </button>
    </form>
  );
}
