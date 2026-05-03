"use client";

import { useEffect, useState } from "react";
import { getPublicApiBase } from "@/lib/publicApi";

const API_BASE = `${getPublicApiBase()}/wallet`;

/** Replace with your real UPI VPA when you have one */
const DISPLAY_UPI_ID = "tradeict-earner@okbank";

export default function DashboardFundsPage() {
  const [amount, setAmount] = useState("");
  const [utr, setUtr] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState(false);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(false), 4500);
    return () => clearTimeout(t);
  }, [toast]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    const num = Number(amount);
    if (!Number.isFinite(num) || num <= 0) {
      setError("Enter a valid deposit amount greater than zero.");
      return;
    }
    const utrTrimmed = utr.trim();
    if (!utrTrimmed) {
      setError("Enter your UTR / transaction reference number.");
      return;
    }

    const token =
      typeof window !== "undefined" ? localStorage.getItem("token") : null;
    if (!token) {
      setError("You need to be logged in to submit a deposit.");
      return;
    }

    setLoading(true);
    try {
      const res = await fetch(`${API_BASE}/topup`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          amount: num,
          utrNumber: utrTrimmed,
        }),
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
      setUtr("");
      setToast(true);
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
          Add funds
        </h1>
        <p className="mt-2 text-sm text-white/55">
          Pay via UPI, then submit your deposit details for admin verification.
        </p>
      </header>

      <div className="glass-card border border-glassBorder p-6 md:p-8 lg:p-10">
        <div className="grid gap-10 lg:grid-cols-2 lg:gap-12">
          <div className="flex flex-col items-center text-center lg:items-start lg:text-left">
            <p className="text-xs font-medium uppercase tracking-wider text-primary">
              Scan &amp; pay
            </p>
            <div className="relative mt-4 overflow-hidden rounded-2xl border border-glassBorder bg-black/30 p-3 shadow-inner">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src="https://via.placeholder.com/250?text=UPI+QR+Code"
                alt="UPI QR Code placeholder"
                width={250}
                height={250}
                className="h-[250px] w-[250px] rounded-lg object-cover"
              />
            </div>
            <div className="mt-6 w-full max-w-xs rounded-xl border border-glassBorder bg-white/[0.04] px-4 py-3 text-left">
              <p className="text-[11px] font-medium uppercase tracking-wide text-white/45">
                UPI ID
              </p>
              <p className="mt-1 font-mono text-sm text-primary">{DISPLAY_UPI_ID}</p>
              <p className="mt-2 text-xs text-white/40">
                Copy this ID in your UPI app if QR scan is unavailable.
              </p>
            </div>
          </div>

          <div>
            <p className="text-xs font-medium uppercase tracking-wider text-primary">
              Submit proof
            </p>
            <h2 className="mt-2 text-lg font-semibold text-white">
              Deposit details
            </h2>
            <p className="mt-1 text-sm text-white/50">
              After paying, enter the amount and UTR so we can verify your transfer.
            </p>

            <form onSubmit={handleSubmit} className="mt-8 space-y-5">
              {error && (
                <div className="rounded-lg border border-red-500/35 bg-red-500/10 px-4 py-3 text-sm text-red-200">
                  {error}
                </div>
              )}

              <label className="block">
                <span className="text-xs font-medium text-white/60">
                  Deposit Amount (INR)
                </span>
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
                <span className="text-xs font-medium text-white/60">
                  UTR / Transaction Reference Number
                </span>
                <input
                  type="text"
                  required
                  value={utr}
                  onChange={(e) => setUtr(e.target.value)}
                  disabled={loading}
                  placeholder="12-digit UTR or bank reference"
                  className="mt-2 w-full rounded-lg border border-glassBorder bg-black/40 px-4 py-3 text-sm text-white outline-none ring-primary/25 placeholder:text-white/30 focus:ring-2 disabled:opacity-50"
                />
              </label>

              <button
                type="submit"
                disabled={loading}
                className="w-full rounded-lg bg-primary py-3 text-sm font-medium text-white shadow-lg shadow-primary/25 transition hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {loading ? "Submitting…" : "Submit deposit request"}
              </button>
            </form>
          </div>
        </div>
      </div>

      {toast && (
        <div
          role="status"
          aria-live="polite"
          className="fixed bottom-6 left-1/2 z-50 w-[calc(100%-2rem)] max-w-md -translate-x-1/2 shadow-2xl"
        >
          <div className="glass-card border border-emerald-500/40 bg-emerald-500/15 px-5 py-4 text-center shadow-2xl">
            <p className="text-sm font-medium text-emerald-100">
              Request submitted! Funds will be added after admin verification.
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
