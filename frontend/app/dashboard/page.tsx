"use client";

import Link from "next/link";
import {
  Activity,
  Calendar,
  CreditCard,
  KeyRound,
  Layers,
  Loader2,
  Percent,
  PlayCircle,
  Wallet,
} from "lucide-react";
import { type ReactNode, useCallback, useEffect, useMemo, useState } from "react";

const API_BASE = process.env.NEXT_PUBLIC_API_URL;

type DashboardOverview = {
  todayPnl: number;
  todayPnlPercent: number;
  monthlyPnl: number;
  monthlyPnlPercent: number;
  availableCapital: number;
  totalDue: number;
  winRate: number;
  activeStrategies: { count: number; names: string[] };
  apiStatus: "connected" | "disconnected";
  copyTradingActive: boolean;
  copyTradingPaused: boolean;
};

function fmtUsd(n: number): string {
  const sign = n < 0 ? "-" : "";
  return `${sign}$${Math.abs(n).toFixed(2)}`;
}

function fmtPct(n: number): string {
  const sign = n > 0 ? "+" : "";
  return `${sign}${n.toFixed(2)}%`;
}

function pnlTone(n: number): string {
  if (n > 0) return "text-emerald-400";
  if (n < 0) return "text-red-400";
  return "text-slate-300";
}

export default function DashboardPage() {
  const [data, setData] = useState<DashboardOverview | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [toggleBusy, setToggleBusy] = useState(false);
  const token = useMemo(
    () => (typeof window !== "undefined" ? localStorage.getItem("token") : null),
    [],
  );

  const loadOverview = useCallback(async () => {
    const res = await fetch(`${API_BASE}/user/dashboard-overview`, {
      headers: { Authorization: `Bearer ${token ?? ""}` },
    });
    if (!res.ok) throw new Error(`Failed to load dashboard (${res.status})`);
    setData((await res.json()) as DashboardOverview);
  }, [token]);

  useEffect(() => {
    void (async () => {
      try {
        await loadOverview();
      } catch (e) {
        setError(e instanceof Error ? e.message : "Failed to load dashboard");
      } finally {
        setLoading(false);
      }
    })();
  }, [loadOverview]);

  async function toggleCopyTrading() {
    if (!data || toggleBusy) return;
    setToggleBusy(true);
    setError(null);
    try {
      const res = await fetch(`${API_BASE}/user/copy-trading`, {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${token ?? ""}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ paused: !data.copyTradingPaused }),
      });
      if (!res.ok) throw new Error(`Could not update copy trading (${res.status})`);
      const body = (await res.json()) as {
        copyTradingPaused: boolean;
        copyTradingActive: boolean;
        apiStatus: "connected" | "disconnected";
      };
      setData((prev) =>
        prev
          ? {
              ...prev,
              copyTradingPaused: body.copyTradingPaused,
              copyTradingActive: body.copyTradingActive,
              apiStatus: body.apiStatus,
            }
          : prev,
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to update copy trading");
    } finally {
      setToggleBusy(false);
    }
  }

  return (
    <div className="space-y-8">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight text-white md:text-3xl">
          Dashboard
        </h1>
        <p className="mt-1 text-sm text-slate-400">
          Real-time overview of your copy-trading performance and account health.
        </p>
      </header>

      {error && (
        <div className="rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-200">
          {error}
        </div>
      )}

      {loading ? (
        <div className="flex justify-center py-24">
          <Loader2 className="h-8 w-8 animate-spin text-cyan-400" />
        </div>
      ) : data ? (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-4">
          <MetricCard
            icon={<Activity className="h-5 w-5 text-cyan-400" />}
            label="Today's PnL"
            value={fmtUsd(data.todayPnl)}
            sub={
              <span className={pnlTone(data.todayPnlPercent)}>
                {fmtPct(data.todayPnlPercent)} of capital
              </span>
            }
            valueClass={pnlTone(data.todayPnl)}
          />

          <MetricCard
            icon={<Calendar className="h-5 w-5 text-violet-400" />}
            label="Monthly PnL"
            value={fmtUsd(data.monthlyPnl)}
            sub={
              <span className={pnlTone(data.monthlyPnlPercent)}>
                {fmtPct(data.monthlyPnlPercent)} of capital
              </span>
            }
            valueClass={pnlTone(data.monthlyPnl)}
          />

          <MetricCard
            icon={<Wallet className="h-5 w-5 text-sky-400" />}
            label="Available Capital"
            value={fmtUsd(data.availableCapital)}
            sub={<span className="text-slate-500">Live Delta balance</span>}
            valueClass="text-white text-3xl"
          />

          <MetricCard
            icon={<CreditCard className="h-5 w-5 text-amber-400" />}
            label="Total Due"
            value={fmtUsd(data.totalDue)}
            sub={
              data.totalDue > 0 ? (
                <Link
                  href="/dashboard/wallet"
                  className="inline-flex items-center rounded-md bg-cyan-500/15 px-2.5 py-1 text-xs font-medium text-cyan-300 ring-1 ring-cyan-500/30 transition hover:bg-cyan-500/25"
                >
                  Pay Now
                </Link>
              ) : (
                <span className="text-slate-500">No pending fees</span>
              )
            }
            valueClass="text-amber-300"
          />

          <MetricCard
            icon={<Percent className="h-5 w-5 text-emerald-400" />}
            label="Total Win Rate"
            value={`${data.winRate.toFixed(1)}%`}
            sub={<span className="text-slate-500">Closed trades this month</span>}
            valueClass="text-white"
          />

          <MetricCard
            icon={<Layers className="h-5 w-5 text-indigo-400" />}
            label="Active Strategies"
            value={String(data.activeStrategies.count)}
            sub={
              data.activeStrategies.names.length > 0 ? (
                <p className="text-xs leading-relaxed text-slate-400">
                  {data.activeStrategies.names.join(" · ")}
                </p>
              ) : (
                <span className="text-slate-500">None deployed</span>
              )
            }
            valueClass="text-3xl text-white"
          />

          <MetricCard
            icon={<KeyRound className="h-5 w-5 text-slate-300" />}
            label="API Status"
            value={data.apiStatus === "connected" ? "Connected" : "Disconnected"}
            sub={
              <StatusDot
                connected={data.apiStatus === "connected"}
                label={
                  data.apiStatus === "connected"
                    ? "Delta keys verified"
                    : "Check API keys in settings"
                }
              />
            }
            valueClass={
              data.apiStatus === "connected" ? "text-emerald-400" : "text-red-400"
            }
          />

          <MetricCard
            icon={<PlayCircle className="h-5 w-5 text-cyan-400" />}
            label="Copy Trading"
            value={data.copyTradingActive ? "Active" : "Paused"}
            sub={
              <div className="flex items-center justify-between gap-3">
                <span className="text-xs text-slate-500">
                  {data.copyTradingPaused
                    ? "Paused globally"
                    : data.apiStatus !== "connected"
                      ? "Connect API to resume"
                      : "Mirroring master trades"}
                </span>
                <ToggleSwitch
                  checked={!data.copyTradingPaused}
                  disabled={toggleBusy}
                  onChange={() => void toggleCopyTrading()}
                />
              </div>
            }
            valueClass={data.copyTradingActive ? "text-emerald-400" : "text-slate-400"}
          />
        </div>
      ) : null}
    </div>
  );
}

function MetricCard({
  icon,
  label,
  value,
  sub,
  valueClass = "text-white",
}: {
  icon: ReactNode;
  label: string;
  value: string;
  sub: ReactNode;
  valueClass?: string;
}) {
  return (
    <div className="rounded-xl border border-slate-800 bg-slate-900 p-5 shadow-lg shadow-black/20">
      <div className="flex items-center gap-2 text-slate-400">
        {icon}
        <p className="text-xs font-medium uppercase tracking-wider">{label}</p>
      </div>
      <p className={`mt-3 text-2xl font-semibold tabular-nums ${valueClass}`}>{value}</p>
      <div className="mt-2 text-sm">{sub}</div>
    </div>
  );
}

function StatusDot({
  connected,
  label,
}: {
  connected: boolean;
  label: string;
}) {
  return (
    <div className="flex items-center gap-2 text-xs text-slate-400">
      <span
        className={`relative inline-flex h-2.5 w-2.5 rounded-full ${
          connected ? "bg-emerald-500" : "bg-red-500"
        }`}
      >
        {connected && (
          <span className="absolute inset-0 animate-ping rounded-full bg-emerald-400 opacity-75" />
        )}
      </span>
      {label}
    </div>
  );
}

function ToggleSwitch({
  checked,
  disabled,
  onChange,
}: {
  checked: boolean;
  disabled?: boolean;
  onChange: () => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={onChange}
      className={`relative h-7 w-12 shrink-0 rounded-full transition-colors ${
        checked ? "bg-emerald-500/80" : "bg-slate-700"
      } ${disabled ? "opacity-50" : ""}`}
    >
      <span
        className={`absolute top-0.5 left-0.5 h-6 w-6 rounded-full bg-white shadow transition-transform ${
          checked ? "translate-x-5" : "translate-x-0"
        }`}
      />
    </button>
  );
}
