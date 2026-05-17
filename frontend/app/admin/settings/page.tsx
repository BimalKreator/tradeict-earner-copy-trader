"use client";

import { useCallback, useEffect, useState } from "react";
import { Loader2, Save } from "lucide-react";

const API_BASE =
  process.env.NEXT_PUBLIC_API_URL?.trim().replace(/\/$/, "") ?? "";

export default function AdminSettingsPage() {
  const [pgFeePercent, setPgFeePercent] = useState("2.36");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
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
      const data = (await res.json()) as { pgFeePercent?: number };
      if (typeof data.pgFeePercent === "number") {
        setPgFeePercent(String(data.pgFeePercent));
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

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSuccess(null);
    const value = Number.parseFloat(pgFeePercent);
    if (!Number.isFinite(value) || value < 0 || value > 100) {
      setError("Enter a valid percentage between 0 and 100.");
      return;
    }
    setSaving(true);
    try {
      const token = localStorage.getItem("token");
      const res = await fetch(`${API_BASE}/admin/settings/payment`, {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${token ?? ""}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ pgFeePercent: value }),
      });
      const data: unknown = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(
          typeof data === "object" && data && "error" in data
            ? String((data as { error: string }).error)
            : `Save failed (${res.status})`,
        );
      }
      setSuccess("Payment gateway fee updated. All payment flows will use the new rate.");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save settings");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-8">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight text-white md:text-3xl">
          Settings
        </h1>
        <p className="mt-2 text-sm text-white/55">
          Configure platform-wide payment options used on the Payments page and Razorpay checkout.
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

      <div className="glass-card max-w-lg border border-glassBorder p-6 md:p-8">
        <h2 className="text-lg font-semibold text-white">Payment gateway fee</h2>
        <p className="mt-1 text-sm text-white/55">
          Applied to Razorpay instant payments (added to total) and manual UPI deposits (deducted
          from base before wallet credit). Bank transfers use 0% fee.
        </p>

        {loading ? (
          <div className="mt-8 flex justify-center py-8">
            <Loader2 className="h-8 w-8 animate-spin text-primary" />
          </div>
        ) : (
          <form onSubmit={handleSave} className="mt-6 space-y-5">
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
                disabled={saving}
                className="mt-2 w-full rounded-lg border border-glassBorder bg-black/40 px-4 py-3 text-sm text-white outline-none focus:ring-2 focus:ring-primary/40"
              />
            </label>
            <p className="text-xs text-white/45">
              Default: 2.36%. Changes apply immediately for new orders and manual deposit
              calculations.
            </p>
            <button
              type="submit"
              disabled={saving}
              className="inline-flex items-center gap-2 rounded-lg bg-primary px-5 py-2.5 text-sm font-medium text-white hover:bg-primary/90 disabled:opacity-50"
            >
              {saving ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Save className="h-4 w-4" />
              )}
              {saving ? "Saving…" : "Save settings"}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
