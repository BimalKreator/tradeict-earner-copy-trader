"use client";

import { resolveApiBase } from "@/lib/apiBase";
import { adminAuthHeaders, adminRequestInit } from "@/lib/adminAuth";
import { useCallback, useEffect, useMemo, useState } from "react";
import { AlertTriangle, Loader2, Save, Shield, UsersRound } from "lucide-react";
import { usePlatformConfig } from "@/context/PlatformConfigContext";

type PartnerCommissionRates = {
  maxTotalPct: number;
  executiveDirectPct: number;
  managerUnderExecutivePct: number;
  directorUnderExecutivePct: number;
  managerDirectPct: number;
  directorUnderManagerPct: number;
  directorDirectPct: number;
};

type CommissionPreviewChain = {
  label: string;
  totalPct: number;
  withinCap: boolean;
  slices: Array<{ role: string; pct: number; amountUsd: number }>;
};

const DEFAULT_PARTNER_RATES: PartnerCommissionRates = {
  maxTotalPct: 8,
  executiveDirectPct: 5,
  managerUnderExecutivePct: 2,
  directorUnderExecutivePct: 1,
  managerDirectPct: 6,
  directorUnderManagerPct: 2,
  directorDirectPct: 8,
};

const PREVIEW_PLATFORM_REVENUE_USD = 100;

function executiveChainTotal(rates: PartnerCommissionRates): number {
  return (
    rates.executiveDirectPct +
    rates.managerUnderExecutivePct +
    rates.directorUnderExecutivePct
  );
}

function managerChainTotal(rates: PartnerCommissionRates): number {
  return rates.managerDirectPct + rates.directorUnderManagerPct;
}

function directorChainTotal(rates: PartnerCommissionRates): number {
  return rates.directorDirectPct;
}

function buildCommissionPreview(
  rates: PartnerCommissionRates,
  platformRevenueUsd = PREVIEW_PLATFORM_REVENUE_USD,
): { chains: CommissionPreviewChain[]; validationError: string | null } {
  const amount = (pct: number) =>
    Math.round(((platformRevenueUsd * pct) / 100) * 100) / 100;

  const executiveTotal = executiveChainTotal(rates);
  const managerTotal = managerChainTotal(rates);
  const directorTotal = directorChainTotal(rates);

  let validationError: string | null = null;
  if (!Number.isFinite(rates.maxTotalPct) || rates.maxTotalPct <= 0) {
    validationError = `maxTotalPct must be greater than 0 (got ${rates.maxTotalPct})`;
  } else if (executiveTotal > rates.maxTotalPct) {
    validationError =
      `Executive chain total ${executiveTotal}% exceeds maxTotalPct cap ${rates.maxTotalPct}%`;
  } else if (managerTotal > rates.maxTotalPct) {
    validationError =
      `Manager chain total ${managerTotal}% exceeds maxTotalPct cap ${rates.maxTotalPct}%`;
  } else if (directorTotal > rates.maxTotalPct) {
    validationError =
      `Senior Manager chain total ${directorTotal}% exceeds maxTotalPct cap ${rates.maxTotalPct}%`;
  }

  return {
    validationError,
    chains: [
      {
        label: "Executive acquired the trader",
        totalPct: executiveTotal,
        withinCap: executiveTotal <= rates.maxTotalPct,
        slices: [
          {
            role: "Executive",
            pct: rates.executiveDirectPct,
            amountUsd: amount(rates.executiveDirectPct),
          },
          {
            role: "Manager (upline)",
            pct: rates.managerUnderExecutivePct,
            amountUsd: amount(rates.managerUnderExecutivePct),
          },
          {
            role: "Senior Manager (upline)",
            pct: rates.directorUnderExecutivePct,
            amountUsd: amount(rates.directorUnderExecutivePct),
          },
        ],
      },
      {
        label: "Manager acquired the trader",
        totalPct: managerTotal,
        withinCap: managerTotal <= rates.maxTotalPct,
        slices: [
          {
            role: "Manager",
            pct: rates.managerDirectPct,
            amountUsd: amount(rates.managerDirectPct),
          },
          {
            role: "Senior Manager (upline)",
            pct: rates.directorUnderManagerPct,
            amountUsd: amount(rates.directorUnderManagerPct),
          },
        ],
      },
      {
        label: "Senior Manager acquired the trader",
        totalPct: directorTotal,
        withinCap: directorTotal <= rates.maxTotalPct,
        slices: [
          {
            role: "Senior Manager",
            pct: rates.directorDirectPct,
            amountUsd: amount(rates.directorDirectPct),
          },
        ],
      },
    ],
  };
}

export default function AdminSettingsPage() {
  const { refresh: refreshPlatformConfig } = usePlatformConfig();
  const [pgFeePercent, setPgFeePercent] = useState("2.36");
  const [usdInrRate, setUsdInrRate] = useState("");
  const [usdInrRateUpdatedAt, setUsdInrRateUpdatedAt] = useState<string | null>(
    null,
  );
  const [usdInrRateUsable, setUsdInrRateUsable] = useState(false);
  const [allowedEmailDomains, setAllowedEmailDomains] = useState(
    "gmail.com,yahoo.com,hotmail.com,outlook.com",
  );
  const [maintenanceMode, setMaintenanceMode] = useState(false);
  const [maintenanceMessage, setMaintenanceMessage] = useState("");
  const [loading, setLoading] = useState(true);
  const [savingPayment, setSavingPayment] = useState(false);
  const [savingSecurity, setSavingSecurity] = useState(false);
  const [savingMaintenance, setSavingMaintenance] = useState(false);
  const [partnerRates, setPartnerRates] = useState<PartnerCommissionRates>(
    DEFAULT_PARTNER_RATES,
  );
  const [savingPartnerCommission, setSavingPartnerCommission] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const commissionPreview = useMemo(
    () => buildCommissionPreview(partnerRates),
    [partnerRates],
  );

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [paymentRes, partnerRes] = await Promise.all([
        fetch(`${resolveApiBase()}/admin/settings/payment`, {
          ...adminRequestInit(), }),
        fetch(`${resolveApiBase()}/admin/settings/partner-commission`, {
          ...adminRequestInit(), }),
      ]);
      if (!paymentRes.ok) {
        throw new Error(`Failed to load settings (${paymentRes.status})`);
      }
      const data = (await paymentRes.json()) as {
        pgFeePercent?: number;
        usdInrRate?: number | null;
        usdInrRateUpdatedAt?: string | null;
        usdInrRateUsable?: boolean;
        allowedEmailDomains?: string;
        maintenanceMode?: boolean;
        maintenanceMessage?: string | null;
      };
      if (partnerRes.ok) {
        const partnerData = (await partnerRes.json()) as Partial<PartnerCommissionRates>;
        setPartnerRates({
          maxTotalPct:
            typeof partnerData.maxTotalPct === "number"
              ? partnerData.maxTotalPct
              : DEFAULT_PARTNER_RATES.maxTotalPct,
          executiveDirectPct:
            typeof partnerData.executiveDirectPct === "number"
              ? partnerData.executiveDirectPct
              : DEFAULT_PARTNER_RATES.executiveDirectPct,
          managerUnderExecutivePct:
            typeof partnerData.managerUnderExecutivePct === "number"
              ? partnerData.managerUnderExecutivePct
              : DEFAULT_PARTNER_RATES.managerUnderExecutivePct,
          directorUnderExecutivePct:
            typeof partnerData.directorUnderExecutivePct === "number"
              ? partnerData.directorUnderExecutivePct
              : DEFAULT_PARTNER_RATES.directorUnderExecutivePct,
          managerDirectPct:
            typeof partnerData.managerDirectPct === "number"
              ? partnerData.managerDirectPct
              : DEFAULT_PARTNER_RATES.managerDirectPct,
          directorUnderManagerPct:
            typeof partnerData.directorUnderManagerPct === "number"
              ? partnerData.directorUnderManagerPct
              : DEFAULT_PARTNER_RATES.directorUnderManagerPct,
          directorDirectPct:
            typeof partnerData.directorDirectPct === "number"
              ? partnerData.directorDirectPct
              : DEFAULT_PARTNER_RATES.directorDirectPct,
        });
      }
      if (typeof data.pgFeePercent === "number") {
        setPgFeePercent(String(data.pgFeePercent));
      }
      if (typeof data.usdInrRate === "number" && data.usdInrRate > 0) {
        setUsdInrRate(String(data.usdInrRate));
      } else {
        setUsdInrRate("");
      }
      setUsdInrRateUpdatedAt(
        typeof data.usdInrRateUpdatedAt === "string"
          ? data.usdInrRateUpdatedAt
          : null,
      );
      setUsdInrRateUsable(data.usdInrRateUsable === true);
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
      const res = await fetch(`${resolveApiBase()}/admin/settings/payment`, {
        method: "PUT",
        headers: {
          
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

  function updatePartnerRate(
    key: keyof PartnerCommissionRates,
    value: string,
  ): void {
    const n = Number.parseFloat(value);
    setPartnerRates((prev) => ({
      ...prev,
      [key]: Number.isFinite(n) ? n : 0,
    }));
  }

  async function handleSavePartnerCommission(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSuccess(null);
    setSavingPartnerCommission(true);
    try {
      const parsed: PartnerCommissionRates = {
        maxTotalPct: Number.parseFloat(String(partnerRates.maxTotalPct)),
        executiveDirectPct: Number.parseFloat(
          String(partnerRates.executiveDirectPct),
        ),
        managerUnderExecutivePct: Number.parseFloat(
          String(partnerRates.managerUnderExecutivePct),
        ),
        directorUnderExecutivePct: Number.parseFloat(
          String(partnerRates.directorUnderExecutivePct),
        ),
        managerDirectPct: Number.parseFloat(String(partnerRates.managerDirectPct)),
        directorUnderManagerPct: Number.parseFloat(
          String(partnerRates.directorUnderManagerPct),
        ),
        directorDirectPct: Number.parseFloat(
          String(partnerRates.directorDirectPct),
        ),
      };
      for (const [key, val] of Object.entries(parsed)) {
        if (!Number.isFinite(val) || val < 0 || val > 100) {
          throw new Error(`${key} must be between 0 and 100`);
        }
      }
      if (parsed.maxTotalPct <= 0) {
        throw new Error("maxTotalPct must be greater than 0");
      }
      const preview = buildCommissionPreview(parsed);
      if (preview.validationError) {
        throw new Error(preview.validationError);
      }
      const res = await fetch(`${resolveApiBase()}/admin/settings/partner-commission`, {
        method: "PUT",
        headers: {
          
          "Content-Type": "application/json",
        },
        body: JSON.stringify(parsed),
      });
      const data: unknown = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(
          typeof data === "object" && data && "error" in data
            ? String((data as { error: string }).error)
            : `Save failed (${res.status})`,
        );
      }
      setSuccess(
        "Partner commission rates updated. New rates apply to future profit events only.",
      );
      void load();
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "Could not save partner commission rates",
      );
    } finally {
      setSavingPartnerCommission(false);
    }
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
                  placeholder="e.g. 88.50"
                  className="mt-2 w-full rounded-lg border border-glassBorder bg-black/40 px-4 py-3 text-sm text-white outline-none focus:ring-2 focus:ring-primary/40"
                />
              </label>
              <p className="text-xs text-white/45">
                Platform rate for wallet display and for pinning INR when invoices are issued.
                Saving updates the rate timestamp. Billing refuses a missing, non-positive, or
                stale rate (default max age 48h via USD_INR_RATE_MAX_AGE_HOURS).
              </p>
              {usdInrRateUpdatedAt ? (
                <p className="text-xs text-white/55">
                  Last set:{" "}
                  {new Date(usdInrRateUpdatedAt).toLocaleString("en-IN", {
                    timeZone: "Asia/Kolkata",
                  })}
                  {usdInrRateUsable ? "" : " — currently unusable for billing (re-save to refresh)."}
                </p>
              ) : (
                <p className="text-xs text-amber-200/90">
                  No rate on file — monthly invoice issue and money paths are blocked until you
                  set one.
                </p>
              )}
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

          <div className="glass-card border border-glassBorder p-6 md:p-8">
            <div className="flex items-center gap-2">
              <UsersRound className="h-5 w-5 text-violet-400" aria-hidden />
              <h2 className="text-lg font-semibold text-white">
                Partner commission rates
              </h2>
            </div>
            <p className="mt-1 text-sm text-white/55">
              Percent of <strong className="font-medium text-white/75">app revenue</strong>{" "}
              (not gross trade PnL) paid to each tier when a referred trader books profit.
              Example: $3.42 gross × 50% app share = $1.71 app revenue → Executive 5% =
              $0.09, Manager 2% = $0.03, Senior Manager 1% = $0.02.
            </p>
            <form onSubmit={handleSavePartnerCommission} className="mt-6 space-y-6">
              <div>
                <h3 className="text-sm font-medium text-white/80">
                  Executive acquired the trader (most common)
                </h3>
                <div className="mt-3 grid gap-4 sm:grid-cols-3">
                  <label className="block text-sm text-white/70">
                    Executive (direct)
                    <input
                      type="number"
                      min={0}
                      max={100}
                      step={0.01}
                      required
                      value={partnerRates.executiveDirectPct}
                      onChange={(e) =>
                        updatePartnerRate("executiveDirectPct", e.target.value)
                      }
                      disabled={savingPartnerCommission}
                      className="mt-2 w-full rounded-lg border border-glassBorder bg-black/40 px-4 py-3 text-sm text-white outline-none focus:ring-2 focus:ring-violet-500/40"
                    />
                  </label>
                  <label className="block text-sm text-white/70">
                    Manager (upline)
                    <input
                      type="number"
                      min={0}
                      max={100}
                      step={0.01}
                      required
                      value={partnerRates.managerUnderExecutivePct}
                      onChange={(e) =>
                        updatePartnerRate(
                          "managerUnderExecutivePct",
                          e.target.value,
                        )
                      }
                      disabled={savingPartnerCommission}
                      className="mt-2 w-full rounded-lg border border-glassBorder bg-black/40 px-4 py-3 text-sm text-white outline-none focus:ring-2 focus:ring-violet-500/40"
                    />
                  </label>
                  <label className="block text-sm text-white/70">
                    Senior Manager (upline)
                    <input
                      type="number"
                      min={0}
                      max={100}
                      step={0.01}
                      required
                      value={partnerRates.directorUnderExecutivePct}
                      onChange={(e) =>
                        updatePartnerRate(
                          "directorUnderExecutivePct",
                          e.target.value,
                        )
                      }
                      disabled={savingPartnerCommission}
                      className="mt-2 w-full rounded-lg border border-glassBorder bg-black/40 px-4 py-3 text-sm text-white outline-none focus:ring-2 focus:ring-violet-500/40"
                    />
                  </label>
                </div>
              </div>

              <div className="grid gap-6 lg:grid-cols-2">
                <div>
                  <h3 className="text-sm font-medium text-white/80">
                    Manager acquired the trader
                  </h3>
                  <div className="mt-3 grid gap-4 sm:grid-cols-2">
                    <label className="block text-sm text-white/70">
                      Manager (direct)
                      <input
                        type="number"
                        min={0}
                        max={100}
                        step={0.01}
                        required
                        value={partnerRates.managerDirectPct}
                        onChange={(e) =>
                          updatePartnerRate("managerDirectPct", e.target.value)
                        }
                        disabled={savingPartnerCommission}
                        className="mt-2 w-full rounded-lg border border-glassBorder bg-black/40 px-4 py-3 text-sm text-white outline-none focus:ring-2 focus:ring-violet-500/40"
                      />
                    </label>
                    <label className="block text-sm text-white/70">
                      Senior Manager (upline)
                      <input
                        type="number"
                        min={0}
                        max={100}
                        step={0.01}
                        required
                        value={partnerRates.directorUnderManagerPct}
                        onChange={(e) =>
                          updatePartnerRate(
                            "directorUnderManagerPct",
                            e.target.value,
                          )
                        }
                        disabled={savingPartnerCommission}
                        className="mt-2 w-full rounded-lg border border-glassBorder bg-black/40 px-4 py-3 text-sm text-white outline-none focus:ring-2 focus:ring-violet-500/40"
                      />
                    </label>
                  </div>
                </div>
                <div>
                  <h3 className="text-sm font-medium text-white/80">
                    Senior Manager acquired the trader
                  </h3>
                  <label className="mt-3 block text-sm text-white/70">
                    Senior Manager (direct)
                    <input
                      type="number"
                      min={0}
                      max={100}
                      step={0.01}
                      required
                      value={partnerRates.directorDirectPct}
                      onChange={(e) =>
                        updatePartnerRate("directorDirectPct", e.target.value)
                      }
                      disabled={savingPartnerCommission}
                      className="mt-2 w-full rounded-lg border border-glassBorder bg-black/40 px-4 py-3 text-sm text-white outline-none focus:ring-2 focus:ring-violet-500/40"
                    />
                  </label>
                </div>
              </div>

              <label className="block max-w-xs text-sm text-white/70">
                Max total per event (%)
                <input
                  type="number"
                  min={0.01}
                  max={100}
                  step={0.01}
                  required
                  value={partnerRates.maxTotalPct}
                  onChange={(e) => updatePartnerRate("maxTotalPct", e.target.value)}
                  disabled={savingPartnerCommission}
                  className="mt-2 w-full rounded-lg border border-glassBorder bg-black/40 px-4 py-3 text-sm text-white outline-none focus:ring-2 focus:ring-violet-500/40"
                />
              </label>

              <div className="rounded-xl border border-white/10 bg-black/30 p-4">
                <h3 className="text-sm font-semibold text-white">
                  Live preview — ${PREVIEW_PLATFORM_REVENUE_USD} platform revenue
                </h3>
                <p className="mt-1 text-xs text-white/45">
                  Percent of app revenue (not gross trade PnL) paid per acquisition
                  path. Each chain total must stay at or below the cap before you
                  can save.
                </p>
                {commissionPreview.validationError ? (
                  <p className="mt-3 rounded-lg border border-red-500/35 bg-red-500/10 px-3 py-2 text-xs text-red-200">
                    {commissionPreview.validationError}
                  </p>
                ) : null}
                <div className="mt-4 space-y-4">
                  {commissionPreview.chains.map((chain) => (
                    <div
                      key={chain.label}
                      className={`rounded-lg border px-3 py-3 ${
                        chain.withinCap
                          ? "border-emerald-500/25 bg-emerald-500/5"
                          : "border-red-500/35 bg-red-500/10"
                      }`}
                    >
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <p className="text-sm font-medium text-white">{chain.label}</p>
                        <p
                          className={`text-xs font-semibold tabular-nums ${
                            chain.withinCap ? "text-emerald-200" : "text-red-200"
                          }`}
                        >
                          Chain total: {chain.totalPct}% / cap {partnerRates.maxTotalPct}%
                        </p>
                      </div>
                      <ul className="mt-2 space-y-1.5">
                        {chain.slices.map((slice) => (
                          <li
                            key={`${chain.label}-${slice.role}`}
                            className="flex items-center justify-between text-xs text-white/70"
                          >
                            <span>{slice.role}</span>
                            <span className="tabular-nums text-white/85">
                              {slice.pct}% → ${slice.amountUsd.toFixed(2)}
                            </span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  ))}
                </div>
              </div>

              <p className="text-xs text-white/45">
                Each acquisition-path total must be at or below the max cap. Save is
                rejected if any chain exceeds it — rates are never silently scaled.
                Changes apply to new profit bookings only — existing ledger rows are
                unchanged.
              </p>
              <button
                type="submit"
                disabled={
                  savingPartnerCommission || commissionPreview.validationError != null
                }
                className="inline-flex items-center gap-2 rounded-lg border border-violet-500/40 bg-violet-500/15 px-5 py-2.5 text-sm font-medium text-violet-100 hover:bg-violet-500/25 disabled:opacity-50"
              >
                {savingPartnerCommission ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Save className="h-4 w-4" />
                )}
                {savingPartnerCommission ? "Saving…" : "Save partner commission rates"}
              </button>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
