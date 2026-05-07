"use client";

import { useCallback, useEffect, useState } from "react";

const API_BASE = process.env.NEXT_PUBLIC_API_URL;

type DepositRow = {
  id: string;
  amount: number;
  transactionId: string;
  screenshotUrl: string | null;
  status: "PENDING" | "APPROVED" | "REJECTED" | string;
  adminReason: string | null;
  createdAt: string;
};

export default function DashboardFundsPage() {
  const [amount, setAmount] = useState("");
  const [transactionId, setTransactionId] = useState("");
  const [screenshot, setScreenshot] = useState<File | null>(null);
  const [loading, setLoading] = useState(false);
  const [historyLoading, setHistoryLoading] = useState(true);
  const [history, setHistory] = useState<DepositRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const token =
    typeof window !== "undefined" ? localStorage.getItem("token") : null;

  useEffect(() => {
    if (!success) return;
    const t = setTimeout(() => setSuccess(null), 4500);
    return () => clearTimeout(t);
  }, [success]);

  const loadHistory = useCallback(async () => {
    if (!token) {
      setHistory([]);
      setHistoryLoading(false);
      return;
    }
    setHistoryLoading(true);
    try {
      const res = await fetch(`${API_BASE}/user/deposits`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) throw new Error(`Failed to load deposit history (${res.status})`);
      const body = (await res.json()) as { deposits?: DepositRow[] };
      setHistory(Array.isArray(body.deposits) ? body.deposits : []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load deposit history.");
      setHistory([]);
    } finally {
      setHistoryLoading(false);
    }
  }, [token]);

  useEffect(() => {
    void loadHistory();
  }, [loadHistory]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSuccess(null);

    const num = Number(amount);
    if (!Number.isFinite(num) || num <= 0) {
      setError("Enter a valid deposit amount greater than zero.");
      return;
    }
    const txTrimmed = transactionId.trim();
    if (!txTrimmed) {
      setError("Enter your transaction ID.");
      return;
    }

    if (!token) {
      setError("You need to be logged in to submit a deposit request.");
      return;
    }

    setLoading(true);
    try {
      const fd = new FormData();
      fd.append("amount", String(num));
      fd.append("transactionId", txTrimmed);
      if (screenshot) fd.append("screenshot", screenshot);

      const res = await fetch(`${API_BASE}/user/deposits`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
        },
        body: fd,
      });

      const data: unknown = await res.json().catch(() => ({}));
      if (!res.ok) {
        const msg =
          typeof data === "object" &&
          data !== null &&
          "error" in data &&
          typeof (data as { error?: unknown }).error === "string"
            ? (data as { error: string }).error
            : `Request failed (${res.status})`;
        throw new Error(msg);
      }

      setAmount("");
      setTransactionId("");
      setScreenshot(null);
      setSuccess("Deposit request submitted successfully.");
      await loadHistory();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="relative">
      <header className="mb-8">
        <h1 className="text-2xl font-semibold tracking-tight text-white md:text-3xl">
          Funds
        </h1>
        <p className="mt-2 text-sm text-white/55">
          Submit your deposit request and track approval status.
        </p>
      </header>

      <div className="space-y-6">
        <div className="glass-card border border-glassBorder p-6 md:p-8">
          <p className="text-xs font-medium uppercase tracking-wider text-primary">
            Bank Details
          </p>
          <div className="mt-3 grid gap-3 md:grid-cols-3">
            <InfoRow label="Account Name" value="TRADEICT AI PRIVATE LIMITED" />
            <InfoRow label="Account No." value="28050200000684" />
            <InfoRow label="IFSC Code" value="BARB0SAPRBS" />
          </div>
        </div>

        <div className="glass-card border border-glassBorder p-6 md:p-8 lg:p-10">
          <p className="text-xs font-medium uppercase tracking-wider text-primary">
            Deposit Request Form
          </p>
          <h2 className="mt-2 text-lg font-semibold text-white">Submit Deposit</h2>
          <p className="mt-1 text-sm text-white/50">
            Enter payment details and optional screenshot proof.
          </p>

          <form onSubmit={handleSubmit} className="mt-8 space-y-5">
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

            <label className="block">
              <span className="text-xs font-medium text-white/60">Amount</span>
              <input
                type="number"
                inputMode="decimal"
                min={0}
                step="0.01"
                required
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                disabled={loading}
                placeholder="e.g. 5000"
                className="mt-2 w-full rounded-lg border border-glassBorder bg-black/40 px-4 py-3 text-sm text-white outline-none ring-primary/25 placeholder:text-white/30 focus:ring-2 disabled:opacity-50"
              />
            </label>

            <label className="block">
              <span className="text-xs font-medium text-white/60">Transaction ID</span>
              <input
                type="text"
                required
                value={transactionId}
                onChange={(e) => setTransactionId(e.target.value)}
                disabled={loading}
                placeholder="Bank or UPI transaction reference"
                className="mt-2 w-full rounded-lg border border-glassBorder bg-black/40 px-4 py-3 text-sm text-white outline-none ring-primary/25 placeholder:text-white/30 focus:ring-2 disabled:opacity-50"
              />
            </label>

            <label className="block">
              <span className="text-xs font-medium text-white/60">
                Payment Screenshot (optional)
              </span>
              <input
                type="file"
                accept="image/*"
                onChange={(e) => setScreenshot(e.target.files?.[0] ?? null)}
                disabled={loading}
                className="mt-2 w-full rounded-lg border border-glassBorder bg-black/40 px-4 py-3 text-sm text-white outline-none ring-primary/25 file:mr-3 file:rounded-md file:border-0 file:bg-primary/20 file:px-3 file:py-1.5 file:text-white disabled:opacity-50"
              />
            </label>

            <button
              type="submit"
              disabled={loading}
              className="w-full rounded-lg bg-primary py-3 text-sm font-medium text-white shadow-lg shadow-primary/25 transition hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {loading ? "Submitting..." : "Submit Deposit Request"}
            </button>
          </form>
        </div>

        <div className="glass-card border border-glassBorder p-6 md:p-8">
          <p className="text-xs font-medium uppercase tracking-wider text-primary">
            Request History
          </p>
          <div className="mt-4 scroll-table overflow-x-auto">
            <table className="w-full min-w-[760px] text-left text-sm">
              <thead className="border-b border-glassBorder bg-white/[0.03] text-white/70">
                <tr>
                  <th className="px-3 py-2 font-medium">Date</th>
                  <th className="px-3 py-2 font-medium">Amount</th>
                  <th className="px-3 py-2 font-medium">TxID</th>
                  <th className="px-3 py-2 font-medium">Status</th>
                  <th className="px-3 py-2 font-medium">Admin Reason</th>
                </tr>
              </thead>
              <tbody>
                {historyLoading ? (
                  <tr>
                    <td colSpan={5} className="px-3 py-8 text-center text-white/45">
                      Loading deposit history...
                    </td>
                  </tr>
                ) : history.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="px-3 py-8 text-center text-white/45">
                      No deposit requests found.
                    </td>
                  </tr>
                ) : (
                  history.map((r) => (
                    <tr key={r.id} className="border-b border-white/[0.06] last:border-0">
                      <td className="px-3 py-2 text-white/60 tabular-nums">
                        {new Date(r.createdAt).toLocaleString()}
                      </td>
                      <td className="px-3 py-2 text-white tabular-nums">
                        ${r.amount.toFixed(2)}
                      </td>
                      <td className="px-3 py-2 text-white/80">{r.transactionId}</td>
                      <td className="px-3 py-2">
                        <span
                          className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${
                            r.status === "APPROVED"
                              ? "bg-emerald-500/15 text-emerald-300"
                              : r.status === "REJECTED"
                                ? "bg-red-500/15 text-red-300"
                                : "bg-amber-500/15 text-amber-200"
                          }`}
                        >
                          {r.status === "PENDING"
                            ? "Pending"
                            : r.status === "APPROVED"
                              ? "Approved"
                              : "Rejected"}
                        </span>
                      </td>
                      <td className="px-3 py-2 text-white/70">
                        {r.adminReason?.trim() || "—"}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>
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
