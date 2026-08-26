"use client";

import { resolveApiBase } from "@/lib/apiBase";
import { adminAuthHeaders, adminRequestInit } from "@/lib/adminAuth";
import {
  DetailRow,
  MoneyRowCard,
  ResponsiveMoneyTable,
} from "@/components/money/MoneyRowCard";
import {
  Activity,
  Banknote,
  Loader2,
  Server,
  TrendingUp,
  Users,
  Wallet,
} from "lucide-react";
import { type ReactNode, useCallback, useEffect, useMemo, useState } from "react";

type CronJobStatus = {
  name: string;
  schedule: string;
  timezone: string | null;
  running: boolean;
  runningSince: string | null;
  runningForMs: number | null;
  lastStartedAt: string | null;
  lastFinishedAt: string | null;
  lastDurationMs: number | null;
  lastSuccess: boolean | null;
  lastError: string | null;
  runCount: number;
  skipCount: number;
};

type CronHealthResponse = {
  checkedAt: string;
  crons: CronJobStatus[];
  summary: {
    total: number;
    running: number;
    failedLastRun: number;
    neverRun: number;
  };
};

type SystemAlertRow = {
  id: string;
  key: string;
  severity: "CRITICAL" | "WARN";
  source: string;
  message: string;
  detail: unknown;
  count: number;
  firstSeenAt: string;
  lastSeenAt: string;
  acknowledgedAt: string | null;
  acknowledgedById: string | null;
  resolved: boolean;
};

type SystemAlertsResponse = {
  alerts: SystemAlertRow[];
  total: number;
};

type DashboardStats = {
  totalUsers: number;
  activeSubscribers: number;
  totalAUM: number;
  systemTodayPnl: number;
  systemMonthlyPnl: number;
  totalPendingRevenue: number;
  masterApiStatus: "connected" | "disconnected";
  masterApiStrategyTitle: string | null;
  pendingApprovals: number;
  leaderboard: Array<{
    rank: number;
    name: string | null;
    email: string;
    totalNetPnl: number;
  }>;
  recentLiveTrades: Array<{
    id: string;
    symbol: string;
    side: string;
    status: string;
    pnl: number;
    createdAt: string;
    userEmail: string;
    strategyTitle: string;
  }>;
};

function fmtUsd(n: number): string {
  const sign = n < 0 ? "-" : "";
  return `${sign}$${Math.abs(n).toFixed(2)}`;
}

function pnlClass(n: number): string {
  if (n > 0) return "text-emerald-400";
  if (n < 0) return "text-red-400";
  return "text-slate-300";
}

function fmtDuration(ms: number | null): string {
  if (ms == null || !Number.isFinite(ms)) return "—";
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.round(ms / 60_000)}m`;
}

function cronStatusLabel(cron: CronJobStatus): string {
  if (cron.running) return "Running";
  if (cron.lastSuccess === false) return "Failed";
  if (cron.lastStartedAt == null) return "Not run yet";
  if (cron.lastSuccess === true) return "OK";
  return "Unknown";
}

function cronStatusClass(cron: CronJobStatus): string {
  if (cron.running) return "text-amber-300";
  if (cron.lastSuccess === false) return "text-red-400";
  if (cron.lastStartedAt == null) return "text-slate-500";
  return "text-emerald-400";
}

function fmtRelative(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms)) return "—";
  const sec = Math.max(0, Math.floor(ms / 1000));
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  return `${day}d ago`;
}

function alertSeverityClass(severity: SystemAlertRow["severity"]): string {
  return severity === "CRITICAL"
    ? "border-red-500/40 bg-red-500/10"
    : "border-amber-500/40 bg-amber-500/10";
}

function alertSeverityTextClass(severity: SystemAlertRow["severity"]): string {
  return severity === "CRITICAL" ? "text-red-300" : "text-amber-300";
}

export default function AdminDashboardPage() {
  const [data, setData] = useState<DashboardStats | null>(null);
  const [cronHealth, setCronHealth] = useState<CronHealthResponse | null>(null);
  const [alerts, setAlerts] = useState<SystemAlertRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [cronError, setCronError] = useState<string | null>(null);
  const [alertsError, setAlertsError] = useState<string | null>(null);
  const [alertActionId, setAlertActionId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const headers = useMemo(() => adminAuthHeaders(), []);

  const loadAlerts = useCallback(async () => {
    try {
      const res = await fetch(
        `${resolveApiBase()}/admin/system/alerts?resolved=false`,
        { ...adminRequestInit(), headers },
      );
      if (!res.ok) {
        setAlertsError(`Alerts unavailable (${res.status})`);
        return;
      }
      const body = (await res.json()) as SystemAlertsResponse;
      setAlerts(body.alerts);
      setAlertsError(null);
    } catch (e) {
      setAlertsError(e instanceof Error ? e.message : "Failed to load alerts");
    }
  }, [headers]);

  const runAlertAction = useCallback(
    async (id: string, action: "ack" | "resolve") => {
      setAlertActionId(id);
      try {
        const res = await fetch(
          `${resolveApiBase()}/admin/system/alerts/${id}/${action}`,
          { ...adminRequestInit(), method: "POST", headers },
        );
        if (!res.ok) {
          const body = (await res.json().catch(() => null)) as { error?: string } | null;
          throw new Error(body?.error ?? `Request failed (${res.status})`);
        }
        if (action === "resolve") {
          setAlerts((prev) => prev.filter((a) => a.id !== id));
        } else {
          const body = (await res.json()) as { alert?: SystemAlertRow };
          if (body.alert) {
            setAlerts((prev) =>
              prev.map((a) => (a.id === id ? body.alert! : a)),
            );
          } else {
            await loadAlerts();
          }
        }
      } catch (e) {
        setAlertsError(e instanceof Error ? e.message : "Alert action failed");
      } finally {
        setAlertActionId(null);
      }
    },
    [headers, loadAlerts],
  );

  useEffect(() => {
    void (async () => {
      try {
        const [statsRes, cronRes, alertsRes] = await Promise.all([
          fetch(`${resolveApiBase()}/admin/dashboard-stats`, { ...adminRequestInit(), headers }),
          fetch(`${resolveApiBase()}/admin/system/cron`, { ...adminRequestInit(), headers }),
          fetch(`${resolveApiBase()}/admin/system/alerts?resolved=false`, { ...adminRequestInit(), headers }),
        ]);
        if (!statsRes.ok) throw new Error(`Request failed (${statsRes.status})`);
        setData((await statsRes.json()) as DashboardStats);
        if (cronRes.ok) {
          setCronHealth((await cronRes.json()) as CronHealthResponse);
          setCronError(null);
        } else {
          setCronError(`Cron health unavailable (${cronRes.status})`);
        }
        if (alertsRes.ok) {
          const body = (await alertsRes.json()) as SystemAlertsResponse;
          setAlerts(body.alerts);
          setAlertsError(null);
        } else {
          setAlertsError(`Alerts unavailable (${alertsRes.status})`);
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : "Failed to load dashboard");
      } finally {
        setLoading(false);
      }
    })();
  }, [headers]);

  return (
    <div className="mx-auto w-full min-w-0 max-w-7xl space-y-8">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight text-white md:text-3xl">
          Admin Command Center
        </h1>
        <p className="mt-1 text-sm text-slate-400">
          Platform-wide capital, performance, and operational health.
        </p>
      </header>

      {error && (
        <div className="rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-200">
          {error}
        </div>
      )}

      {cronError && (
        <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-100">
          {cronError}
        </div>
      )}

      {alertsError && (
        <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-100">
          {alertsError}
        </div>
      )}

      {loading ? (
        <div className="flex justify-center py-24">
          <Loader2 className="h-8 w-8 animate-spin text-cyan-400" />
        </div>
      ) : data ? (
        <>
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-4">
            <AdminCard
              icon={<Users className="h-5 w-5 text-cyan-400" />}
              label="Users & Subscribers"
              value={
                <span>
                  <span className="text-white">{data.totalUsers}</span>
                  <span className="text-slate-500"> Total / </span>
                  <span className="text-emerald-400">{data.activeSubscribers}</span>
                  <span className="text-slate-500"> Active</span>
                </span>
              }
              hint="Registered users · active strategy subscriptions"
            />

            <AdminCard
              icon={<Wallet className="h-5 w-5 text-sky-400" />}
              label="Total AUM (Capital)"
              value={fmtUsd(data.totalAUM)}
              hint="Sum of linked Delta balances"
              valueClass="text-3xl text-white"
            />

            <AdminCard
              icon={<TrendingUp className="h-5 w-5 text-violet-400" />}
              label="System-Wide PnL"
              value={
                <div className="space-y-1">
                  <p className={`text-lg font-semibold tabular-nums ${pnlClass(data.systemTodayPnl)}`}>
                    Today {fmtUsd(data.systemTodayPnl)}
                  </p>
                  <p className={`text-sm tabular-nums ${pnlClass(data.systemMonthlyPnl)}`}>
                    Month {fmtUsd(data.systemMonthlyPnl)}
                  </p>
                </div>
              }
              hint="Realized PnL from closed trades (UTC)"
            />

            <AdminCard
              icon={<Banknote className="h-5 w-5 text-amber-400" />}
              label="Expected Revenue"
              value={fmtUsd(data.totalPendingRevenue)}
              hint="Unpaid invoice dues across all users"
              valueClass="text-amber-300"
            />
          </div>

          <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
            <AdminCard
              icon={<Server className="h-5 w-5 text-slate-300" />}
              label="Master API Health"
              value={
                data.masterApiStatus === "connected" ? "Connected" : "Disconnected"
              }
              hint={
                data.masterApiStrategyTitle
                  ? `Strategy: ${data.masterApiStrategyTitle}`
                  : "No master keys configured"
              }
              valueClass={
                data.masterApiStatus === "connected"
                  ? "text-emerald-400"
                  : "text-red-400"
              }
              trailing={
                <StatusDot connected={data.masterApiStatus === "connected"} />
              }
            />

            <AdminCard
              icon={<Activity className="h-5 w-5 text-amber-300" />}
              label="Pending Approvals"
              value={String(data.pendingApprovals)}
              hint="Profile update requests awaiting review"
              className="lg:col-span-2"
            />
          </div>

          <section className="rounded-xl border border-slate-800 bg-slate-900 p-5 shadow-lg shadow-black/20">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h2 className="text-sm font-medium uppercase tracking-wider text-slate-400">
                  Alerts
                </h2>
                <p className="mt-1 text-xs text-slate-500">
                  Open operational alerts from billing, ledger sync, and cron jobs.
                </p>
              </div>
              <button
                type="button"
                onClick={() => void loadAlerts()}
                className="rounded-lg border border-slate-700 px-3 py-1.5 text-xs text-slate-300 hover:bg-slate-800"
              >
                Refresh
              </button>
            </div>

            {alerts.length === 0 ? (
              <p className="mt-4 text-sm text-emerald-400">No open alerts</p>
            ) : (
              <div className="mt-4">
                <ResponsiveMoneyTable
                  table={
                    <div className="divide-y divide-slate-800">
                      {alerts.map((alert) => (
                        <AlertDesktopRow
                          key={alert.id}
                          alert={alert}
                          busy={alertActionId === alert.id}
                          onAck={() => void runAlertAction(alert.id, "ack")}
                          onResolve={() => void runAlertAction(alert.id, "resolve")}
                        />
                      ))}
                    </div>
                  }
                  cards={alerts.map((alert) => (
                    <AlertMobileCard
                      key={alert.id}
                      alert={alert}
                      busy={alertActionId === alert.id}
                      onAck={() => void runAlertAction(alert.id, "ack")}
                      onResolve={() => void runAlertAction(alert.id, "resolve")}
                    />
                  ))}
                />
              </div>
            )}
          </section>

          <section className="rounded-xl border border-slate-800 bg-slate-900 p-5 shadow-lg shadow-black/20">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h2 className="text-sm font-medium uppercase tracking-wider text-slate-400">
                  Scheduled Jobs (Cron Health)
                </h2>
                {cronHealth ? (
                  <p className="mt-1 text-xs text-slate-500">
                    {cronHealth.summary.total} jobs · {cronHealth.summary.running} running ·{" "}
                    {cronHealth.summary.failedLastRun} failed last run · checked{" "}
                    {new Date(cronHealth.checkedAt).toLocaleString()}
                  </p>
                ) : null}
              </div>
            </div>
            <div className="mt-4 overflow-x-auto">
              <table className="w-full min-w-[920px] text-left text-sm">
                <thead>
                  <tr className="border-b border-slate-800 text-xs uppercase tracking-wider text-slate-500">
                    <th className="px-3 py-3 font-medium">Job</th>
                    <th className="px-3 py-3 font-medium">Schedule</th>
                    <th className="px-3 py-3 font-medium">Status</th>
                    <th className="px-3 py-3 font-medium">Last run</th>
                    <th className="px-3 py-3 font-medium">Duration</th>
                    <th className="px-3 py-3 font-medium text-right">Runs</th>
                    <th className="px-3 py-3 font-medium text-right">Skips</th>
                  </tr>
                </thead>
                <tbody>
                  {(cronHealth?.crons ?? []).map((cron) => (
                    <tr
                      key={cron.name}
                      className="border-b border-slate-800/80 transition hover:bg-slate-800/30"
                    >
                      <td className="px-3 py-3 font-mono text-xs text-slate-200">
                        {cron.name}
                      </td>
                      <td className="px-3 py-3 text-slate-400">
                        <span className="font-mono text-xs">{cron.schedule}</span>
                        {cron.timezone ? (
                          <span className="ml-2 text-[11px] text-slate-600">
                            ({cron.timezone})
                          </span>
                        ) : null}
                      </td>
                      <td className={`px-3 py-3 font-medium ${cronStatusClass(cron)}`}>
                        {cronStatusLabel(cron)}
                        {cron.running && cron.runningForMs != null ? (
                          <span className="ml-2 text-xs text-slate-500">
                            {fmtDuration(cron.runningForMs)}
                          </span>
                        ) : null}
                      </td>
                      <td className="px-3 py-3 text-slate-400">
                        {cron.lastFinishedAt
                          ? new Date(cron.lastFinishedAt).toLocaleString()
                          : cron.lastStartedAt
                            ? `${new Date(cron.lastStartedAt).toLocaleString()} (in progress)`
                            : "—"}
                      </td>
                      <td className="px-3 py-3 text-slate-300 tabular-nums">
                        {fmtDuration(cron.lastDurationMs)}
                      </td>
                      <td className="px-3 py-3 text-right tabular-nums text-slate-300">
                        {cron.runCount}
                      </td>
                      <td className="px-3 py-3 text-right tabular-nums text-slate-300">
                        {cron.skipCount > 0 ? (
                          <span className="text-amber-300">{cron.skipCount}</span>
                        ) : (
                          cron.skipCount
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {!cronHealth?.crons.length && !cronError ? (
                <p className="mt-4 text-sm text-slate-500">No cron jobs registered yet.</p>
              ) : null}
            </div>
          </section>

          <section className="rounded-xl border border-slate-800 bg-slate-900 p-5 shadow-lg shadow-black/20">
            <h2 className="text-sm font-medium uppercase tracking-wider text-slate-400">
              Top Users by Profit
            </h2>
            <div className="mt-4 space-y-2">
              {data.leaderboard.map((u) => (
                <div
                  key={`${u.rank}-${u.email}`}
                  className="flex items-center justify-between rounded-lg border border-slate-800 bg-slate-950/60 px-4 py-3 text-sm"
                >
                  <span className="text-slate-200">
                    <span className="mr-2 font-mono text-slate-500">#{u.rank}</span>
                    {u.name ?? u.email}
                  </span>
                  <span className={`font-semibold tabular-nums ${pnlClass(u.totalNetPnl)}`}>
                    {fmtUsd(u.totalNetPnl)}
                  </span>
                </div>
              ))}
              {data.leaderboard.length === 0 && (
                <p className="text-sm text-slate-500">No closed trade data yet.</p>
              )}
            </div>
          </section>

          <section className="rounded-xl border border-slate-800 bg-slate-900 p-5 shadow-lg shadow-black/20">
            <h2 className="text-sm font-medium uppercase tracking-wider text-slate-400">
              Recent Live Trades
            </h2>
            <div className="mt-4 overflow-x-auto">
              <table className="w-full min-w-[760px] text-left text-sm">
                <thead>
                  <tr className="border-b border-slate-800 text-xs uppercase tracking-wider text-slate-500">
                    <th className="px-3 py-3 font-medium">Time</th>
                    <th className="px-3 py-3 font-medium">User</th>
                    <th className="px-3 py-3 font-medium">Strategy</th>
                    <th className="px-3 py-3 font-medium">Symbol</th>
                    <th className="px-3 py-3 font-medium">Side</th>
                    <th className="px-3 py-3 font-medium">Status</th>
                    <th className="px-3 py-3 font-medium text-right">Net PnL</th>
                  </tr>
                </thead>
                <tbody>
                  {data.recentLiveTrades.map((t) => (
                    <tr
                      key={t.id}
                      className="border-b border-slate-800/80 transition hover:bg-slate-800/30"
                    >
                      <td className="px-3 py-3 text-slate-400">
                        {new Date(t.createdAt).toLocaleString()}
                      </td>
                      <td className="px-3 py-3 text-slate-200">{t.userEmail}</td>
                      <td className="px-3 py-3 text-slate-300">{t.strategyTitle}</td>
                      <td className="px-3 py-3 font-mono text-slate-300">{t.symbol}</td>
                      <td className="px-3 py-3 text-slate-300">{t.side}</td>
                      <td className="px-3 py-3">
                        <span className="rounded-md bg-slate-800 px-2 py-0.5 text-xs text-slate-300">
                          {t.status}
                        </span>
                      </td>
                      <td
                        className={`px-3 py-3 text-right font-medium tabular-nums ${pnlClass(t.pnl)}`}
                      >
                        {fmtUsd(t.pnl)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {data.recentLiveTrades.length === 0 && (
                <p className="mt-4 text-sm text-slate-500">No recent trades.</p>
              )}
            </div>
          </section>
        </>
      ) : null}
    </div>
  );
}

function AdminCard({
  icon,
  label,
  value,
  hint,
  valueClass = "text-2xl text-white",
  trailing,
  className = "",
}: {
  icon: ReactNode;
  label: string;
  value: ReactNode;
  hint: string;
  valueClass?: string;
  trailing?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={`rounded-xl border border-slate-800 bg-slate-900 p-5 shadow-lg shadow-black/20 ${className}`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-2 text-slate-400">
          {icon}
          <p className="text-xs font-medium uppercase tracking-wider">{label}</p>
        </div>
        {trailing}
      </div>
      <div className={`mt-3 font-semibold tabular-nums ${valueClass}`}>{value}</div>
      <p className="mt-2 text-xs text-slate-500">{hint}</p>
    </div>
  );
}

function StatusDot({ connected }: { connected: boolean }) {
  return (
    <span
      className={`relative mt-1 inline-flex h-3 w-3 rounded-full ${
        connected ? "bg-emerald-500" : "bg-red-500"
      }`}
    >
      {connected && (
        <span className="absolute inset-0 animate-ping rounded-full bg-emerald-400 opacity-75" />
      )}
    </span>
  );
}

function AlertActionButtons({
  busy,
  onAck,
  onResolve,
}: {
  busy: boolean;
  onAck: () => void;
  onResolve: () => void;
}) {
  return (
    <div className="flex flex-wrap gap-2">
      <button
        type="button"
        disabled={busy}
        onClick={(e) => {
          e.stopPropagation();
          onAck();
        }}
        className="rounded-md border border-slate-600 px-2.5 py-1 text-xs text-slate-200 hover:bg-slate-800 disabled:opacity-50"
      >
        Ack
      </button>
      <button
        type="button"
        disabled={busy}
        onClick={(e) => {
          e.stopPropagation();
          onResolve();
        }}
        className="rounded-md border border-slate-600 px-2.5 py-1 text-xs text-slate-200 hover:bg-slate-800 disabled:opacity-50"
      >
        Resolve
      </button>
    </div>
  );
}

function AlertDetails({ detail }: { detail: unknown }) {
  if (detail == null) {
    return <p className="text-sm text-slate-500">No detail payload.</p>;
  }
  return (
    <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-all rounded-md bg-slate-950/80 p-3 font-mono text-xs text-slate-300">
      {JSON.stringify(detail, null, 2)}
    </pre>
  );
}

function AlertDesktopRow({
  alert,
  busy,
  onAck,
  onResolve,
}: {
  alert: SystemAlertRow;
  busy: boolean;
  onAck: () => void;
  onResolve: () => void;
}) {
  const [showDetails, setShowDetails] = useState(false);
  const acked = alert.acknowledgedAt != null;

  return (
    <div
      className={`px-4 py-4 ${acked ? "opacity-60" : ""} ${alertSeverityClass(alert.severity)} border-l-4`}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span
              className={`rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${alertSeverityTextClass(alert.severity)}`}
            >
              {alert.severity}
            </span>
            <span className="font-mono text-xs text-slate-400">{alert.source}</span>
            {acked ? (
              <span className="rounded bg-slate-800 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-slate-400">
                acked
              </span>
            ) : null}
          </div>
          <p className="mt-2 text-sm text-slate-100">{alert.message}</p>
          <p className="mt-1 text-xs text-slate-500">
            seen {alert.count}x · last {fmtRelative(alert.lastSeenAt)} · key{" "}
            <span className="font-mono">{alert.key}</span>
          </p>
          {alert.detail != null ? (
            <button
              type="button"
              onClick={() => setShowDetails((v) => !v)}
              className="mt-2 text-xs text-cyan-400 hover:text-cyan-300"
            >
              {showDetails ? "Hide details" : "Details"}
            </button>
          ) : null}
          {showDetails ? (
            <div className="mt-2">
              <AlertDetails detail={alert.detail} />
            </div>
          ) : null}
        </div>
        <AlertActionButtons busy={busy} onAck={onAck} onResolve={onResolve} />
      </div>
    </div>
  );
}

function AlertMobileCard({
  alert,
  busy,
  onAck,
  onResolve,
}: {
  alert: SystemAlertRow;
  busy: boolean;
  onAck: () => void;
  onResolve: () => void;
}) {
  const acked = alert.acknowledgedAt != null;

  return (
    <div className={acked ? "opacity-60" : ""}>
      <MoneyRowCard
        primary={alert.message}
        secondary={`${alert.source} · seen ${alert.count}x · ${fmtRelative(alert.lastSeenAt)}`}
        amount={
          <span
            className={`rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase ${alertSeverityTextClass(alert.severity)}`}
          >
            {alert.severity}
          </span>
        }
        status={
          acked ? (
            <span className="rounded bg-slate-800 px-1.5 py-0.5 text-[10px] uppercase text-slate-400">
              acked
            </span>
          ) : null
        }
        details={
          <div className="space-y-3">
            <DetailRow label="Key" value={<span className="font-mono text-xs">{alert.key}</span>} />
            <DetailRow label="First seen" value={new Date(alert.firstSeenAt).toLocaleString()} />
            <DetailRow label="Last seen" value={new Date(alert.lastSeenAt).toLocaleString()} />
            {alert.detail != null ? (
              <div>
                <p className="mb-2 text-xs uppercase tracking-wide text-slate-500">Details</p>
                <AlertDetails detail={alert.detail} />
              </div>
            ) : null}
            <AlertActionButtons busy={busy} onAck={onAck} onResolve={onResolve} />
          </div>
        }
      />
    </div>
  );
}
