"use client";

import { useEffect, useState } from "react";

const API_BASE =
  process.env.NEXT_PUBLIC_API_URL?.trim().replace(/\/$/, "") ?? "";

const inputClass =
  "mt-1 w-full rounded-lg border border-white/15 bg-black/40 px-3 py-2.5 text-white outline-none transition focus:border-cyan-500/50 focus:ring-2 focus:ring-cyan-500/30";

const SUCCESS_MESSAGE =
  "Application submitted! Our team will contact you shortly to integrate your strategy.";

export function ExpertApplicationForm() {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const [toastVisible, setToastVisible] = useState(false);

  useEffect(() => {
    if (!toastVisible) return;
    const t = window.setTimeout(() => setToastVisible(false), 6000);
    return () => window.clearTimeout(t);
  }, [toastVisible]);

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setLoading(true);

    const form = e.currentTarget;
    const fd = new FormData(form);

    const payload = {
      name: String(fd.get("name") ?? "").trim(),
      email: String(fd.get("email") ?? "").trim(),
      mobile: String(fd.get("mobile") ?? "").trim(),
      exchange: String(fd.get("exchange") ?? "").trim(),
      strategyIdea: String(fd.get("strategyIdea") ?? "").trim(),
      requiredCapital: String(fd.get("requiredCapital") ?? "").trim(),
      expectedRevenueShare: Number.parseFloat(
        String(fd.get("expectedRevenueShare") ?? ""),
      ),
    };

    try {
      const res = await fetch(`${API_BASE}/public/apply-expert`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const body: unknown = await res.json().catch(() => ({}));
      if (!res.ok) {
        const msg =
          typeof body === "object" &&
          body !== null &&
          "error" in body &&
          typeof (body as { error?: unknown }).error === "string"
            ? (body as { error: string }).error
            : `Request failed (${res.status})`;
        throw new Error(msg);
      }
      setSuccess(true);
      setToastVisible(true);
      form.reset();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not submit application");
    } finally {
      setLoading(false);
    }
  }

  return (
    <>
      {toastVisible && (
        <div
          role="status"
          className="fixed bottom-6 left-1/2 z-50 w-[min(24rem,calc(100vw-2rem))] -translate-x-1/2 rounded-xl border border-emerald-400/40 bg-slate-900/95 px-4 py-3.5 text-center text-sm text-emerald-100 shadow-lg shadow-emerald-500/10 backdrop-blur-md"
        >
          {SUCCESS_MESSAGE}
        </div>
      )}

      <section className="rounded-2xl border border-white/10 bg-slate-900/50 p-6 sm:p-8">
        <h2 className="text-xl font-semibold text-white">Apply as an Expert Trader</h2>
        <p className="mt-1 text-sm text-white/55">
          Complete the form below. We review every application and respond within a few business
          days.
        </p>

        {success && !toastVisible && (
          <p className="mt-6 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-4 py-3 text-sm text-emerald-200">
            {SUCCESS_MESSAGE}
          </p>
        )}

        <form onSubmit={handleSubmit} className="mt-8 grid gap-5 sm:grid-cols-2">
            <label className="block text-sm text-white/70 sm:col-span-2">
              Full Name
              <input type="text" name="name" required autoComplete="name" className={inputClass} />
            </label>
            <label className="block text-sm text-white/70">
              Email Address
              <input
                type="email"
                name="email"
                required
                autoComplete="email"
                className={inputClass}
              />
            </label>
            <label className="block text-sm text-white/70">
              Mobile Number
              <input
                type="tel"
                name="mobile"
                required
                autoComplete="tel"
                className={inputClass}
              />
            </label>
            <label className="block text-sm text-white/70 sm:col-span-2">
              Preferred Exchange(s)
              <input
                type="text"
                name="exchange"
                required
                placeholder="e.g. Delta Exchange, Binance"
                className={inputClass}
              />
            </label>
            <label className="block text-sm text-white/70 sm:col-span-2">
              Brief Strategy Idea / Edge
              <textarea
                name="strategyIdea"
                rows={5}
                required
                placeholder="Describe your approach, markets, timeframes, and risk controls…"
                className={`${inputClass} resize-y`}
              />
            </label>
            <label className="block text-sm text-white/70">
              Minimum Capital Required to Trade
              <input
                type="text"
                name="requiredCapital"
                required
                inputMode="decimal"
                placeholder="e.g. 50000 INR"
                className={inputClass}
              />
            </label>
            <label className="block text-sm text-white/70">
              Expected Revenue Share %
              <input
                type="number"
                name="expectedRevenueShare"
                required
                min={0}
                max={100}
                step={0.1}
                placeholder="e.g. 20"
                className={inputClass}
              />
            </label>
            {error && (
              <p className="sm:col-span-2 rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-200">
                {error}
              </p>
            )}
            <div className="sm:col-span-2">
              <button
                type="submit"
                disabled={loading}
                className="w-full rounded-lg bg-gradient-to-r from-cyan-600 to-cyan-500 px-4 py-3 text-sm font-semibold text-white shadow-lg shadow-cyan-500/20 transition hover:from-cyan-500 hover:to-cyan-400 disabled:cursor-not-allowed disabled:opacity-60 sm:w-auto sm:min-w-[200px]"
              >
                {loading ? "Submitting…" : "Submit Application"}
              </button>
            </div>
          </form>
      </section>
    </>
  );
}
