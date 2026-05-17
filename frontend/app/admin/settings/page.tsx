"use client";

import { useCallback, useEffect, useState } from "react";
import { Loader2, Save, Shield } from "lucide-react";

const API_BASE =
  process.env.NEXT_PUBLIC_API_URL?.trim().replace(/\/$/, "") ?? "";

export default function AdminSettingsPage() {
  const [pgFeePercent, setPgFeePercent] = useState("2.36");
  const [allowedEmailDomains, setAllowedEmailDomains] = useState(
    "gmail.com,yahoo.com,hotmail.com,outlook.com",
  );
  const [loading, setLoading] = useState(true);
  const [savingPayment, setSavingPayment] = useState(false);
  const [savingSecurity, setSavingSecurity] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const token = localStorage.getItem("token");
      const res = await fetch(`${API_BASE}/admin/settings/payment`, {
        headers: { Authorization: `Bearer ${token ?? ""}` },
      });
      if (!res.ok) throw new Error(`Failed to load settings (${res.status})`);
      const data = (await res.json()) as {
        pgFeePercent?: number;
        allowedEmailDomains?: string;
      };
      if (typeof data.pgFeePercent === "number") {
        setPgFeePercent(String(data.pgFeePercent));
      }
      if (typeof data.allowedEmailDomains === "string") {
        setAllowedEmailDomains(data.allowedEmailDomains);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load settings");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function saveSettings(
    payload: { pgFeePercent?: number; allowedEmailDomains?: string },
    kind: "payment" | "security",
  ): Promise<void> {
    setError(null);
    setSuccess(null);
    if (kind === "payment") setSavingPayment(true);
    else setSavingSecurity(true);
    try {
      const token = localStorage.getItem("token");
      const res = await fetch(`${API_BASE}/admin/settings/payment`, {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${token ?? ""}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      });
      const data: unknown = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(
          typeof data === "object" && data && "error" in data
            ? String((data as { error: string }).error)
            : `Save failed (${res.status})`,
        );
      }
      if (kind === "payment") {
        setSuccess("Payment gateway fee updated. All payment flows will use the new rate.");
      } else {
        setSuccess("Allowed email domains updated. Sign-up and login now use the new list.");
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save settings");
    } finally {
      if (kind === "payment") setSavingPayment(false);
      else setSavingSecurity(false);
    }
  }

  async function handleSavePayment(e: React.FormEvent) {
    e.preventDefault();
    const value = Number.parseFloat(pgFeePercent);
    if (!Number.isFinite(value) || value < 0 || value > 100) {
      setError("Enter a valid percentage between 0 and 100.");
      return;
    }
    await saveSettings({ pgFeePercent: value }, "payment");
  }

  async function handleSaveSecurity(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = allowedEmailDomains.trim();
    if (!trimmed) {
      setError("Enter at least one allowed email domain.");
      return;
    }
    await saveSettings({ allowedEmailDomains: trimmed }, "security");
  }

  return (
    <div className="space-y-8">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight text-white md:text-3xl">
          Settings
        </h1>
        <p className="mt-2 text-sm text-white/55">
          Configure platform-wide payment options and sign-up security.
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

      {loading ? (
        <div className="flex justify-center py-16">
          <Loader2 className="h-8 w-8 animate-spin text-primary" />
        </div>
      ) : (
        <div className="grid gap-8 lg:grid-cols-2">
          <div className="glass-card border border-glassBorder p-6 md:p-8">
            <h2 className="text-lg font-semibold text-white">Payment gateway fee</h2>
            <p className="mt-1 text-sm text-white/55">
              Applied to Razorpay instant payments (added to total) and manual UPI deposits
              (deducted from base before wallet credit). Bank transfers use 0% fee.
            </p>
            <form onSubmit={handleSavePayment} className="mt-6 space-y-5">
              <label className="block text-sm text-white/70">
                Payment Gateway Fee (%)
                <input
                  type="number"
                  min={0}
                  max={100}
                  step={0.01}
                  required
                  value={pgFeePercent}
                  onChange={(e) => setPgFeePercent(e.target.value)}
                  disabled={savingPayment}
                  className="mt-2 w-full rounded-lg border border-glassBorder bg-black/40 px-4 py-3 text-sm text-white outline-none focus:ring-2 focus:ring-primary/40"
                />
              </label>
              <p className="text-xs text-white/45">
                Default: 2.36%. Changes apply immediately for new orders and manual deposit
                calculations.
              </p>
              <button
                type="submit"
                disabled={savingPayment}
                className="inline-flex items-center gap-2 rounded-lg bg-primary px-5 py-2.5 text-sm font-medium text-white hover:bg-primary/90 disabled:opacity-50"
              >
                {savingPayment ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Save className="h-4 w-4" />
                )}
                {savingPayment ? "Saving…" : "Save payment settings"}
              </button>
            </form>
          </div>

          <div className="glass-card border border-glassBorder p-6 md:p-8">
            <div className="flex items-center gap-2">
              <Shield className="h-5 w-5 text-cyan-400" aria-hidden />
              <h2 className="text-lg font-semibold text-white">Security / Anti-Spam</h2>
            </div>
            <p className="mt-1 text-sm text-white/55">
              Block disposable and unknown email providers at sign-up and login.
            </p>
            <form onSubmit={handleSaveSecurity} className="mt-6 space-y-5">
              <label className="block text-sm text-white/70">
                Allowed Email Domains (comma separated)
                <textarea
                  rows={4}
                  required
                  value={allowedEmailDomains}
                  onChange={(e) => setAllowedEmailDomains(e.target.value)}
                  disabled={savingSecurity}
                  placeholder="gmail.com, yahoo.com, yourcompany.com"
                  className="mt-2 w-full resize-y rounded-lg border border-glassBorder bg-black/40 px-4 py-3 text-sm text-white outline-none focus:ring-2 focus:ring-primary/40"
                />
              </label>
              <p className="text-xs text-white/45">
                Only emails ending with these domains can sign up or log in. E.g., gmail.com,
                yourcompany.com
              </p>
              <button
                type="submit"
                disabled={savingSecurity}
                className="inline-flex items-center gap-2 rounded-lg border border-cyan-500/40 bg-cyan-500/15 px-5 py-2.5 text-sm font-medium text-cyan-100 hover:bg-cyan-500/25 disabled:opacity-50"
              >
                {savingSecurity ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Save className="h-4 w-4" />
                )}
                {savingSecurity ? "Saving…" : "Save security settings"}
              </button>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
