"use client";

import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, Loader2, Save, Shield } from "lucide-react";
import { usePlatformConfig } from "@/context/PlatformConfigContext";

const API_BASE =
  process.env.NEXT_PUBLIC_API_URL?.trim().replace(/\/$/, "") ?? "";

export default function AdminSettingsPage() {
  const { refresh: refreshPlatformConfig } = usePlatformConfig();
  const [pgFeePercent, setPgFeePercent] = useState("2.36");
  const [usdInrRate, setUsdInrRate] = useState("83");
  const [allowedEmailDomains, setAllowedEmailDomains] = useState(
    "gmail.com,yahoo.com,hotmail.com,outlook.com",
  );
  const [maintenanceMode, setMaintenanceMode] = useState(false);
  const [maintenanceMessage, setMaintenanceMessage] = useState("");
  const [loading, setLoading] = useState(true);
  const [savingPayment, setSavingPayment] = useState(false);
  const [savingSecurity, setSavingSecurity] = useState(false);
  const [savingMaintenance, setSavingMaintenance] = useState(false);
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
        usdInrRate?: number;
        allowedEmailDomains?: string;
        maintenanceMode?: boolean;
        maintenanceMessage?: string | null;
      };
      if (typeof data.pgFeePercent === "number") {
        setPgFeePercent(String(data.pgFeePercent));
      }
      if (typeof data.usdInrRate === "number") {
        setUsdInrRate(String(data.usdInrRate));
      }
      if (typeof data.allowedEmailDomains === "string") {
        setAllowedEmailDomains(data.allowedEmailDomains);
      }
      setMaintenanceMode(data.maintenanceMode === true);
      setMaintenanceMessage(
        typeof data.maintenanceMessage === "string" ? data.maintenanceMessage : "",
      );
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
    payload: {
      pgFeePercent?: number;
      usdInrRate?: number;
      allowedEmailDomains?: string;
      maintenanceMode?: boolean;
      maintenanceMessage?: string | null;
    },
    kind: "payment" | "security" | "maintenance",
  ): Promise<void> {
    setError(null);
    setSuccess(null);
    if (kind === "payment") setSavingPayment(true);
    else if (kind === "security") setSavingSecurity(true);
    else setSavingMaintenance(true);
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
        setSuccess(
          "Payment settings updated. Razorpay, wallet INR display, and invoice conversion will use the new values.",
        );
      } else if (kind === "security") {
        setSuccess("Allowed email domains updated. Sign-up and login now use the new list.");
      } else {
        setSuccess(
          "Maintenance notice updated. Users will see the red banner when mode is enabled.",
        );
        await refreshPlatformConfig();
        void load();
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save settings");
    } finally {
      if (kind === "payment") setSavingPayment(false);
      else if (kind === "security") setSavingSecurity(false);
      else setSavingMaintenance(false);
    }
  }

  async function handleSaveMaintenance(e: React.FormEvent) {
    e.preventDefault();
    if (maintenanceMode && !maintenanceMessage.trim()) {
      setError("Enter a maintenance message when maintenance mode is enabled.");
      return;
    }
    await saveSettings(
      {
        maintenanceMode,
        maintenanceMessage: maintenanceMessage.trim() || null,
      },
      "maintenance",
    );
  }

  async function handleSavePayment(e: React.FormEvent) {
    e.preventDefault();
    const fee = Number.parseFloat(pgFeePercent);
    const fx = Number.parseFloat(usdInrRate);
    if (!Number.isFinite(fee) || fee < 0 || fee > 100) {
      setError("Enter a valid fee percentage between 0 and 100.");
      return;
    }
    if (!Number.isFinite(fx) || fx <= 0) {
      setError("Enter a valid USD to INR rate (positive number).");
      return;
    }
    await saveSettings({ pgFeePercent: fee, usdInrRate: fx }, "payment");
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
          Configure maintenance notices, payment options, and sign-up security.
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
        <div className="space-y-8">
          <div className="glass-card border border-red-500/30 bg-red-500/[0.06] p-6 md:p-8">
            <div className="flex items-center gap-2">
              <AlertTriangle className="h-5 w-5 text-red-400" aria-hidden />
              <h2 className="text-lg font-semibold text-white">Maintenance notice</h2>
            </div>
            <p className="mt-1 text-sm text-white/55">
              Shows a fixed red banner at the top of the site for all users when enabled.
            </p>
            <form onSubmit={handleSaveMaintenance} className="mt-6 space-y-5">
              <label className="flex cursor-pointer items-center justify-between gap-4 rounded-lg border border-white/10 bg-black/30 px-4 py-3">
                <span className="text-sm font-medium text-white">Maintenance mode</span>
                <input
                  type="checkbox"
                  checked={maintenanceMode}
                  onChange={(e) => setMaintenanceMode(e.target.checked)}
                  disabled={savingMaintenance}
                  className="h-5 w-5 rounded border-white/20 bg-black/50 text-red-500 focus:ring-red-500/40"
                />
              </label>
              <label className="block text-sm text-white/70">
                Maintenance message
                <textarea
                  rows={3}
                  value={maintenanceMessage}
                  onChange={(e) => setMaintenanceMessage(e.target.value)}
                  disabled={savingMaintenance}
                  placeholder="e.g. Scheduled maintenance until 6 PM IST. Copy trading is paused."
                  className="mt-2 w-full resize-y rounded-lg border border-glassBorder bg-black/40 px-4 py-3 text-sm text-white outline-none focus:ring-2 focus:ring-red-500/40"
                />
              </label>
              <button
                type="submit"
                disabled={savingMaintenance}
                className="inline-flex items-center gap-2 rounded-lg border border-red-500/50 bg-red-600/90 px-5 py-2.5 text-sm font-medium text-white hover:bg-red-600 disabled:opacity-50"
              >
                {savingMaintenance ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Save className="h-4 w-4" />
                )}
                {savingMaintenance ? "Saving…" : "Save maintenance settings"}
              </button>
            </form>
          </div>

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
              <label className="block text-sm text-white/70">
                USD to INR Conversion Rate
                <input
                  type="number"
                  min={0.01}
                  step={0.01}
                  required
                  value={usdInrRate}
                  onChange={(e) => setUsdInrRate(e.target.value)}
                  disabled={savingPayment}
                  placeholder="e.g. 83.5"
                  className="mt-2 w-full rounded-lg border border-glassBorder bg-black/40 px-4 py-3 text-sm text-white outline-none focus:ring-2 focus:ring-primary/40"
                />
              </label>
              <p className="text-xs text-white/45">
                Used for Razorpay checkout, wallet INR display, and invoice USD→INR conversion.
                No longer read from environment variables.
              </p>
              <p className="text-xs text-white/45">
                Default fee: 2.36%. Changes apply immediately for new orders and deposits.
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
        </div>
      )}
    </div>
  );
}
