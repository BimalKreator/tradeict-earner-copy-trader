"use client";

import { useCallback, useEffect, useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  Layers,
  Loader2,
  Radio,
  RefreshCw,
  RotateCcw,
  Shield,
  Target,
  TrendingDown,
  Users,
  Wifi,
  WifiOff,
} from "lucide-react";
import Link from "next/link";

const ENV_API_BASE =
  process.env.NEXT_PUBLIC_API_URL?.trim().replace(/\/$/, "") ?? "";

function resolveAdminApiBase(): string {
  if (ENV_API_BASE) return ENV_API_BASE;
  if (typeof window !== "undefined") {
    return `${window.location.origin.replace(/\/$/, "")}/api`;
  }
  return "";
}

type LiveRow = {
  entryTime: string | null;
  token: string;
  size: number | null;
  entryPrice: number | null;
  stopLoss: number | null;
  target: number | null;
  livePnl: number | null;
  markPrice: number | null;
  side: string;
};

type FollowerRow = LiveRow & { userId: string; userEmail: string };

type SubscriberUser = {
  userId: string;
  userEmail: string;
  userName?: string | null;
  multiplier: number;
  syncStatus?: string;
  syncError?: string | null;
  positions: LiveRow[];
};

type MasterMeta = {
  credentialsPresent: boolean;
  fetchException?: string;
};

type StrategySection = {
  strategyId: string;
  strategyTitle: string;
  strategyIsActive: boolean;
  autoExitEnabled: boolean;
  autoExitTarget: number | null;
  autoExitStopLoss: number | null;
  masterPositions: LiveRow[];
  subscribers: SubscriberUser[];
  masterMeta: MasterMeta;
};

const LIVE_TRADES_REFRESH_MS = 8_000;

interface AutoExitPayload {
  autoExitEnabled?: boolean;
  autoExitTarget?: number | null;
  autoExitStopLoss?: number | null;
}

type AutoExitSaved = Pick<
  StrategySection,
  "autoExitEnabled" | "autoExitTarget" | "autoExitStopLoss"
>;

function parseAutoExitSaved(payload: unknown): AutoExitSaved | undefined {
  if (typeof payload !== "object" || payload === null) return undefined;
  const p = payload as AutoExitPayload;
  return {
    autoExitEnabled:
      typeof p.autoExitEnabled === "boolean" ? p.autoExitEnabled : false,
    autoExitTarget:
      p.autoExitTarget === null || typeof p.autoExitTarget === "number"
        ? (p.autoExitTarget ?? null)
        : null,
    autoExitStopLoss:
      p.autoExitStopLoss === null || typeof p.autoExitStopLoss === "number"
        ? (p.autoExitStopLoss ?? null)
        : null,
  };
}

const usdPriceFmt = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 6,
});

const usdPnlFmt = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
  signDisplay: "always",
});

function fmtPrice(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  return usdPriceFmt.format(n);
}

function fmtPnl(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  return usdPnlFmt.format(n);
}

function sumLivePnl(rows: LiveRow[]): number {
  return rows.reduce((acc, r) => {
    if (r.livePnl != null && Number.isFinite(r.livePnl)) return acc + r.livePnl;
    return acc;
  }, 0);
}

function formatMultiplier(m: number): string {
  if (!Number.isFinite(m) || m <= 0) return "1x";
  const rounded = Math.round(m * 100) / 100;
  return Number.isInteger(rounded) ? `${rounded}x` : `${rounded}x`;
}

function followerLotsFromMaster(masterLots: number, multiplier: number): number {
  const scaled = Math.abs(masterLots) * multiplier;
  return Math.max(1, Math.floor(scaled));
}

function symbolsRoughMatch(a: string, b: string): boolean {
  const x = a.replace(/[/:]/g, "").toUpperCase();
  const y = b.replace(/[/:]/g, "").toUpperCase();
  return x === y || x.endsWith(y) || y.endsWith(x);
}

function subscriberSyncFailed(user: SubscriberUser): boolean {
  const status = (user.syncStatus ?? "SYNCED").toUpperCase();
  return status === "FAILED" || status === "ERROR";
}

/** True when follower leg sizes don't match master × multiplier. */
function subscriberOutOfSync(
  user: SubscriberUser,
  masterPositions: LiveRow[],
): boolean {
  if (masterPositions.length === 0) return false;
  for (const master of masterPositions) {
    const masterLots = master.size ?? 0;
    if (!Number.isFinite(masterLots) || masterLots <= 0) continue;
    const expected = followerLotsFromMaster(masterLots, user.multiplier);
    const leg = user.positions.find(
      (p) =>
        symbolsRoughMatch(p.token, master.token) &&
        p.side.toUpperCase() === master.side.toUpperCase(),
    );
    const actual =
      leg?.size != null && Number.isFinite(leg.size)
        ? Math.max(0, Math.floor(leg.size))
        : 0;
    if (actual !== expected) return true;
  }
  return false;
}

function subscriberNeedsManualSync(
  user: SubscriberUser,
  masterPositions: LiveRow[],
): boolean {
  return subscriberSyncFailed(user) || subscriberOutOfSync(user, masterPositions);
}

function syncFailureLabel(user: SubscriberUser): string {
  const raw = user.syncError?.trim();
  if (!raw) return "Copy sync failed";
  return raw.length > 80 ? `${raw.slice(0, 77)}…` : raw;
}

function parseStrategyGroups(data: unknown): StrategySection[] {
  const rawList = Array.isArray(data)
    ? data
    : typeof data === "object" &&
        data !== null &&
        "strategies" in data &&
        Array.isArray((data as { strategies: unknown }).strategies)
      ? (data as { strategies: unknown[] }).strategies
      : [];

  return rawList.map((item) => {
    const row = item as Record<string, unknown>;
    const strat =
      typeof row.strategy === "object" && row.strategy !== null
        ? (row.strategy as Record<string, unknown>)
        : row;
    const metaRaw =
      typeof row.masterMeta === "object" && row.masterMeta !== null
        ? (row.masterMeta as Record<string, unknown>)
        : {};

    return {
      strategyId: String(strat.id ?? row.strategyId ?? ""),
      strategyTitle: String(strat.title ?? row.strategyTitle ?? "Strategy"),
      strategyIsActive: strat.isActive !== false,
      autoExitEnabled:
        typeof strat.autoExitEnabled === "boolean"
          ? strat.autoExitEnabled
          : typeof row.autoExitEnabled === "boolean"
            ? row.autoExitEnabled
            : false,
      autoExitTarget:
        typeof strat.autoExitTarget === "number"
          ? strat.autoExitTarget
          : typeof row.autoExitTarget === "number"
            ? row.autoExitTarget
            : null,
      autoExitStopLoss:
        typeof strat.autoExitStopLoss === "number"
          ? strat.autoExitStopLoss
          : typeof row.autoExitStopLoss === "number"
            ? row.autoExitStopLoss
            : null,
      masterPositions: Array.isArray(row.masterPositions)
        ? (row.masterPositions as LiveRow[])
        : [],
      subscribers: Array.isArray(row.subscribers)
        ? (row.subscribers as SubscriberUser[]).map((sub) => {
            const s = sub as Record<string, unknown>;
            return {
              userId: String(s.userId ?? ""),
              userEmail: String(s.userEmail ?? ""),
              userName:
                typeof s.userName === "string" ? s.userName : null,
              multiplier:
                typeof s.multiplier === "number" ? s.multiplier : 1,
              syncStatus:
                typeof s.syncStatus === "string" ? s.syncStatus : "SYNCED",
              syncError:
                typeof s.syncError === "string"
                  ? s.syncError
                  : s.syncError === null
                    ? null
                    : null,
              positions: Array.isArray(s.positions)
                ? (s.positions as LiveRow[])
                : [],
            };
          })
        : [],
      masterMeta: {
        credentialsPresent: Boolean(metaRaw.credentialsPresent),
        fetchException:
          typeof metaRaw.fetchException === "string"
            ? metaRaw.fetchException
            : undefined,
      },
    };
  });
}

function MasterApiStatusBadge({ meta }: { meta: MasterMeta }) {
  if (!meta.credentialsPresent) {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full bg-amber-500/15 px-2.5 py-1 text-xs font-medium text-amber-100 ring-1 ring-amber-500/35">
        <WifiOff className="h-3.5 w-3.5" aria-hidden />
        Keys missing
      </span>
    );
  }
  if (meta.fetchException) {
    const shortErr =
      meta.fetchException.length > 72
        ? `${meta.fetchException.slice(0, 69)}…`
        : meta.fetchException;
    return (
      <span
        className="inline-flex max-w-lg items-center gap-1.5 rounded-full bg-red-500/15 px-2.5 py-1 text-xs font-medium text-red-200 ring-1 ring-red-500/35"
        title={meta.fetchException}
      >
        <WifiOff className="h-3.5 w-3.5 shrink-0" aria-hidden />
        API error: {shortErr}
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-500/15 px-2.5 py-1 text-xs font-medium text-emerald-200 ring-1 ring-emerald-500/35">
      <Wifi className="h-3.5 w-3.5" aria-hidden />
      Master connected
    </span>
  );
}

function MasterLegsTable({
  rows,
  strategyId,
  onCloseTrade,
  closingKey,
}: {
  rows: LiveRow[];
  strategyId: string;
  onCloseTrade: (args: {
    strategyId: string;
    symbol: string;
    side: string;
    size: number;
    isMaster: boolean;
  }) => Promise<void>;
  closingKey: string | null;
}) {
  if (rows.length === 0) {
    return (
      <p className="px-4 py-8 text-center text-sm text-white/50">
        No open positions on this strategy&apos;s master Delta account.
      </p>
    );
  }

  return (
    <div className="scroll-table overflow-x-auto">
      <table className="w-full min-w-[720px] text-left text-sm">
        <thead className="border-b border-primary/30 bg-primary/10">
          <tr>
            <th className="px-4 py-3 font-medium text-white/80">Token</th>
            <th className="px-4 py-3 font-medium text-white/80">Side</th>
            <th className="px-4 py-3 font-medium text-white/80">Entry price</th>
            <th className="px-4 py-3 font-medium text-white/80">Live PnL</th>
            <th className="px-4 py-3 font-medium text-white/80">Mark price</th>
            <th className="px-4 py-3 font-medium text-white/80">Actions</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, idx) => (
            <tr
              key={`${r.token}-${r.side}-${idx}`}
              className="border-b border-white/[0.05] transition-colors last:border-0 hover:bg-white/[0.02]"
            >
              <td className="px-4 py-3 font-medium text-white">{r.token}</td>
              <td className="px-4 py-3 text-white/70">{r.side}</td>
              <td className="px-4 py-3 tabular-nums text-white/85">
                {fmtPrice(r.entryPrice)}
              </td>
              <td
                className={`px-4 py-3 tabular-nums font-semibold ${
                  r.livePnl != null && r.livePnl >= 0
                    ? "text-emerald-400"
                    : r.livePnl != null
                      ? "text-red-300"
                      : "text-white/50"
                }`}
              >
                {fmtPnl(r.livePnl)}
              </td>
              <td className="px-4 py-3 tabular-nums text-white/85">
                {fmtPrice(r.markPrice)}
              </td>
              <td className="px-4 py-3">
                {r.size != null && r.size > 0 ? (
                  <button
                    type="button"
                    disabled={
                      closingKey ===
                      `${strategyId}:${r.token}:${r.side}:master`
                    }
                    onClick={() =>
                      void onCloseTrade({
                        strategyId,
                        symbol: r.token,
                        side: r.side,
                        size: r.size ?? 0,
                        isMaster: true,
                      })
                    }
                    className="rounded-md border border-red-500/45 bg-red-500/15 px-2.5 py-1 text-xs font-medium text-red-200 transition hover:bg-red-500/25 disabled:opacity-50"
                  >
                    Close
                  </button>
                ) : (
                  <span className="text-white/35">—</span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function SubscriberAccordionItem({
  user,
  strategyId,
  masterPositions,
  expanded,
  onToggle,
  onCloseTrade,
  closingKey,
  onSyncUser,
  syncingUserId,
}: {
  user: SubscriberUser;
  strategyId: string;
  masterPositions: LiveRow[];
  expanded: boolean;
  onToggle: () => void;
  onCloseTrade: (args: {
    strategyId: string;
    userId?: string;
    symbol: string;
    side: string;
    size: number;
    isMaster: boolean;
  }) => Promise<void>;
  closingKey: string | null;
  onSyncUser: (strategyId: string, userId: string) => Promise<void>;
  syncingUserId: string | null;
}) {
  const totalPnl = sumLivePnl(user.positions);
  const pnlPositive = totalPnl > 0;
  const pnlNegative = totalPnl < 0;
  const displayName = user.userName?.trim() || user.userEmail;
  const failed = subscriberSyncFailed(user);
  const outOfSync = subscriberOutOfSync(user, masterPositions);
  const showSync = subscriberNeedsManualSync(user, masterPositions);
  const isSyncing = syncingUserId === user.userId;

  return (
    <div
      className={`overflow-hidden rounded-xl border bg-black/25 ${
        failed
          ? "border-red-500/45 ring-1 ring-red-500/20"
          : outOfSync
            ? "border-amber-500/35 ring-1 ring-amber-500/15"
            : "border-white/10"
      }`}
    >
      <div className="flex w-full items-stretch gap-0">
        <button
          type="button"
          onClick={onToggle}
          className="flex min-w-0 flex-1 items-center gap-3 px-4 py-3 text-left transition hover:bg-white/[0.03]"
          aria-expanded={expanded}
        >
          {expanded ? (
            <ChevronDown className="h-4 w-4 shrink-0 text-white/50" />
          ) : (
            <ChevronRight className="h-4 w-4 shrink-0 text-white/50" />
          )}
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <p className="truncate text-sm font-medium text-white">
                {displayName}
              </p>
              {failed ? (
                <span
                  className="inline-flex max-w-full items-center rounded-md bg-red-500/20 px-2 py-0.5 text-xs font-semibold text-red-200 ring-1 ring-red-500/40"
                  title={syncFailureLabel(user)}
                >
                  Failed: {syncFailureLabel(user)}
                </span>
              ) : outOfSync ? (
                <span className="inline-flex items-center rounded-md bg-amber-500/15 px-2 py-0.5 text-xs font-medium text-amber-100 ring-1 ring-amber-500/35">
                  Out of sync
                </span>
              ) : null}
            </div>
            <p className="text-xs text-white/45">
              {user.userEmail} · Multiplier{" "}
              <span className="font-semibold text-violet-300">
                {formatMultiplier(user.multiplier)}
              </span>
              · {user.positions.length} leg
              {user.positions.length === 1 ? "" : "s"}
            </p>
          </div>
          <p
            className={`shrink-0 text-sm font-bold tabular-nums ${
              pnlPositive
                ? "text-emerald-400"
                : pnlNegative
                  ? "text-red-400"
                  : "text-white/60"
            }`}
          >
            {fmtPnl(totalPnl)}
          </p>
        </button>
        {showSync ? (
          <div className="flex shrink-0 items-center border-l border-white/[0.06] px-3">
            <button
              type="button"
              disabled={isSyncing}
              onClick={(e) => {
                e.stopPropagation();
                void onSyncUser(strategyId, user.userId);
              }}
              className="inline-flex items-center gap-1.5 rounded-lg border border-violet-500/45 bg-violet-500/15 px-2.5 py-1.5 text-xs font-medium text-violet-100 transition hover:bg-violet-500/25 disabled:cursor-not-allowed disabled:opacity-60"
              title="Mirror master open positions to this follower"
            >
              {isSyncing ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
              ) : (
                <RotateCcw className="h-3.5 w-3.5" aria-hidden />
              )}
              {isSyncing ? "Syncing…" : "Force Copy / Sync Trade"}
            </button>
          </div>
        ) : null}
      </div>
      {expanded ? (
        <div className="border-t border-white/[0.06]">
          {user.positions.length > 0 ? (
            <PositionTable
              rows={user.positions}
              variant="subscriber"
              strategyId={strategyId}
              followerUserId={user.userId}
              onCloseTrade={onCloseTrade}
              closingKey={closingKey}
            />
          ) : (
            <p className="px-4 py-6 text-sm text-white/45">
              No open positions on this follower&apos;s Delta account.
            </p>
          )}
        </div>
      ) : null}
    </div>
  );
}

function StrategyLivePanel({
  strategy,
  isActiveTab,
  expandedSubs,
  onToggleSubscriber,
  onCloseTrade,
  closingKey,
  onAutoExitSaved,
  onSyncUser,
  syncingUserId,
}: {
  strategy: StrategySection;
  isActiveTab: boolean;
  expandedSubs: Set<string>;
  onToggleSubscriber: (userId: string) => void;
  onCloseTrade: (args: {
    strategyId: string;
    userId?: string;
    symbol: string;
    side: string;
    size: number;
    isMaster: boolean;
  }) => Promise<void>;
  closingKey: string | null;
  onAutoExitSaved: (message: string, updated?: AutoExitSaved) => void;
  onSyncUser: (strategyId: string, userId: string) => Promise<void>;
  syncingUserId: string | null;
}) {
  const masterPnl = sumLivePnl(strategy.masterPositions);

  return (
    <div
      className="space-y-6"
      aria-hidden={!isActiveTab}
    >
      <div className="flex flex-col gap-3 border-b border-white/10 pb-4 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-xl font-semibold tracking-tight text-white">
              {strategy.strategyTitle}
            </h2>
            {!strategy.strategyIsActive ? (
              <span className="rounded-full bg-amber-500/15 px-2 py-0.5 text-xs font-medium text-amber-100 ring-1 ring-amber-500/30">
                Strategy paused
              </span>
            ) : null}
          </div>
          <p className="mt-1 font-mono text-xs text-white/45">
            ID {strategy.strategyId}
          </p>
        </div>
        <MasterApiStatusBadge meta={strategy.masterMeta} />
      </div>

      <RiskManagementPanel
        strategy={strategy}
        totalLivePnl={masterPnl}
        onSaved={onAutoExitSaved}
      />

      <section className="overflow-hidden rounded-xl border border-primary/25 bg-black/20">
        <div className="flex items-center justify-between border-b border-primary/25 bg-primary/5 px-4 py-3">
          <div>
            <p className="text-xs font-semibold uppercase tracking-wider text-primary">
              Master Delta
            </p>
            <p className="mt-0.5 text-xs text-white/45">
              Leader open legs (CCXT / Delta India)
            </p>
          </div>
          <span className="rounded-md bg-white/5 px-2 py-1 text-xs tabular-nums text-white/60">
            {strategy.masterPositions.length} open
          </span>
        </div>
        <MasterLegsTable
          rows={strategy.masterPositions}
          strategyId={strategy.strategyId}
          onCloseTrade={onCloseTrade}
          closingKey={closingKey}
        />
      </section>

      <section>
        <div className="mb-3 flex items-center justify-between gap-2">
          <div>
            <h3 className="text-sm font-semibold text-white">Subscribers</h3>
            <p className="text-xs text-white/45">
              Active copy subscriptions for this strategy only
            </p>
          </div>
          <span className="inline-flex items-center gap-1 rounded-md bg-violet-500/10 px-2 py-1 text-xs text-violet-200 ring-1 ring-violet-500/25">
            <Users className="h-3.5 w-3.5" aria-hidden />
            {strategy.subscribers.length}
          </span>
        </div>
        {strategy.subscribers.length === 0 ? (
          <p className="rounded-xl border border-dashed border-white/10 px-4 py-8 text-center text-sm text-white/45">
            No active subscribers with open positions for this strategy.
          </p>
        ) : (
          <div className="space-y-2">
            {strategy.subscribers.map((user) => (
              <SubscriberAccordionItem
                key={user.userId}
                user={user}
                strategyId={strategy.strategyId}
                masterPositions={strategy.masterPositions}
                expanded={expandedSubs.has(user.userId)}
                onToggle={() => onToggleSubscriber(user.userId)}
                onCloseTrade={onCloseTrade}
                closingKey={closingKey}
                onSyncUser={onSyncUser}
                syncingUserId={syncingUserId}
              />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

function AutoExitToggleSwitch({
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
      aria-label="Enable auto-exit target and stop loss"
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

function RiskManagementPanel({
  strategy,
  totalLivePnl,
  onSaved,
}: {
  strategy: StrategySection;
  totalLivePnl: number;
  onSaved: (message: string, updated?: AutoExitSaved) => void;
}) {
  const [autoExitEnabled, setAutoExitEnabled] = useState(strategy.autoExitEnabled);
  const [targetInput, setTargetInput] = useState(
    strategy.autoExitTarget != null ? String(strategy.autoExitTarget) : "",
  );
  const [stopInput, setStopInput] = useState(
    strategy.autoExitStopLoss != null ? String(strategy.autoExitStopLoss) : "",
  );
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setAutoExitEnabled(strategy.autoExitEnabled);
    setTargetInput(
      strategy.autoExitTarget != null ? String(strategy.autoExitTarget) : "",
    );
    setStopInput(
      strategy.autoExitStopLoss != null ? String(strategy.autoExitStopLoss) : "",
    );
  }, [
    strategy.autoExitEnabled,
    strategy.autoExitTarget,
    strategy.autoExitStopLoss,
  ]);

  const inputsDisabled = !autoExitEnabled;

  const pnlPositive = totalLivePnl > 0;
  const pnlNegative = totalLivePnl < 0;

  const saveAutoExit = async () => {
    const base = resolveAdminApiBase();
    if (!base) {
      onSaved("API base URL is not configured.");
      return;
    }

    const body: {
      autoExitEnabled: boolean;
      autoExitTarget?: number | null;
      autoExitStopLoss?: number | null;
    } = { autoExitEnabled };

    if (targetInput.trim() === "") {
      body.autoExitTarget = null;
    } else {
      const t = Number(targetInput);
      if (!Number.isFinite(t) || t < 0) {
        onSaved("Target profit must be a non-negative number.");
        return;
      }
      body.autoExitTarget = t;
    }

    if (stopInput.trim() === "") {
      body.autoExitStopLoss = null;
    } else {
      const s = Number(stopInput);
      if (!Number.isFinite(s) || s <= 0) {
        onSaved("Stop loss must be a positive number.");
        return;
      }
      body.autoExitStopLoss = s;
    }

    setSaving(true);
    try {
      const res = await fetch(
        `${base}/admin/strategies/${strategy.strategyId}/auto-exit`,
        {
          method: "PATCH",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${localStorage.getItem("token") ?? ""}`,
          },
          body: JSON.stringify(body),
        },
      );
      const payload: unknown = await res.json().catch(() => ({}));
      if (!res.ok) {
        const msg =
          typeof payload === "object" &&
          payload !== null &&
          "error" in payload &&
          typeof (payload as { error: unknown }).error === "string"
            ? (payload as { error: string }).error
            : `Save failed (${res.status})`;
        throw new Error(msg);
      }
      const saved = parseAutoExitSaved(payload);
      onSaved("Auto-exit settings saved.", saved);
    } catch (e) {
      onSaved(e instanceof Error ? e.message : "Failed to save auto-exit");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      className="mt-6 overflow-hidden rounded-xl border border-amber-500/25 bg-gradient-to-br from-amber-500/[0.07] via-black/30 to-emerald-500/[0.05] p-4 md:p-5"
    >
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex items-start gap-3">
          <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-2.5">
            <Shield className="h-5 w-5 text-amber-300" aria-hidden />
          </div>
          <div>
            <h3 className="text-sm font-semibold tracking-wide text-white">
              Risk Management &amp; Summary
            </h3>
            <p className="mt-0.5 max-w-xl text-xs text-white/45">
              Total unrealized PnL across all master legs. When thresholds are
              hit, the trade engine closes every master position (followers copy
              via WebSocket).
            </p>
          </div>
        </div>
        <div className="text-right">
          <p className="text-[10px] font-medium uppercase tracking-wider text-white/40">
            Total live PnL
          </p>
          <p
            className={`mt-0.5 text-2xl font-bold tabular-nums ${
              pnlPositive
                ? "text-emerald-400"
                : pnlNegative
                  ? "text-red-400"
                  : "text-white/70"
            }`}
          >
            {fmtPnl(totalLivePnl)}
          </p>
        </div>
      </div>

      <div className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-white/10 bg-black/25 px-3 py-2.5">
        <div>
          <p className="text-sm font-medium text-white">
            Enable Auto-Exit (Target/SL)
          </p>
          <p className="text-xs text-white/45">
            When off, target and stop loss thresholds are saved but not enforced.
          </p>
        </div>
        <AutoExitToggleSwitch
          checked={autoExitEnabled}
          disabled={saving}
          onChange={() => setAutoExitEnabled((prev) => !prev)}
        />
      </div>

      <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-[1fr_1fr_auto] lg:items-end">
        <label className={`block ${inputsDisabled ? "opacity-45" : ""}`}>
          <span className="flex items-center gap-1.5 text-xs font-medium text-white/55">
            <Target className="h-3.5 w-3.5 text-emerald-400/80" aria-hidden />
            Target profit ($)
          </span>
          <input
            type="number"
            min={0}
            step="any"
            placeholder="e.g. 500"
            value={targetInput}
            disabled={inputsDisabled}
            onChange={(e) => setTargetInput(e.target.value)}
            className="mt-1.5 w-full rounded-lg border border-white/10 bg-black/40 px-3 py-2 text-sm text-white placeholder:text-white/30 focus:border-emerald-500/50 focus:outline-none focus:ring-1 focus:ring-emerald-500/30 disabled:cursor-not-allowed disabled:bg-black/20"
          />
        </label>
        <label className={`block ${inputsDisabled ? "opacity-45" : ""}`}>
          <span className="flex items-center gap-1.5 text-xs font-medium text-white/55">
            <TrendingDown className="h-3.5 w-3.5 text-red-400/80" aria-hidden />
            Stop loss ($)
          </span>
          <input
            type="number"
            min={0}
            step="any"
            placeholder="e.g. 5 (exits at −$5)"
            value={stopInput}
            disabled={inputsDisabled}
            onChange={(e) => setStopInput(e.target.value)}
            className="mt-1.5 w-full rounded-lg border border-white/10 bg-black/40 px-3 py-2 text-sm text-white placeholder:text-white/30 focus:border-red-500/50 focus:outline-none focus:ring-1 focus:ring-red-500/30 disabled:cursor-not-allowed disabled:bg-black/20"
          />
        </label>
        <button
          type="button"
          disabled={saving}
          onClick={() => void saveAutoExit()}
          className="rounded-lg border border-primary/50 bg-primary/20 px-4 py-2 text-sm font-medium text-primary transition hover:bg-primary/30 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {saving ? "Saving…" : "Save Auto-Exit"}
        </button>
      </div>
    </div>
  );
}

function fmtTime(iso: string | null): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

function PositionTable({
  rows,
  variant,
  strategyId,
  followerUserId,
  onCloseTrade,
  closingKey,
}: {
  rows: (LiveRow | FollowerRow)[];
  variant: "master" | "follower" | "subscriber";
  strategyId: string;
  followerUserId?: string;
  onCloseTrade: (args: {
    strategyId: string;
    userId?: string;
    symbol: string;
    side: string;
    size: number;
    isMaster: boolean;
  }) => Promise<void>;
  closingKey: string | null;
}) {
  const showSourceColumn = variant !== "subscriber";
  const closeUserId =
    variant === "subscriber"
      ? followerUserId
      : variant === "follower"
        ? (rows[0] as FollowerRow | undefined)?.userId
        : undefined;

  return (
    <div className="scroll-table overflow-x-auto">
      <table className="w-full min-w-[900px] text-left text-sm">
        <thead
          className={
            variant === "master"
              ? "border-b border-primary/35 bg-primary/10"
              : "border-b border-white/[0.08] bg-black/25"
          }
        >
          <tr>
            {showSourceColumn ? (
              variant === "follower" ? (
                <th className="px-3 py-2 font-medium text-white/70">User</th>
              ) : (
                <th className="px-3 py-2 font-medium text-primary/90">Source</th>
              )
            ) : null}
            <th className="px-3 py-2 font-medium text-white/70">Entry time</th>
            <th className="px-3 py-2 font-medium text-white/70">Token</th>
            <th className="px-3 py-2 font-medium text-white/70">Side</th>
            <th className="px-3 py-2 font-medium text-white/70">Entry price</th>
            <th className="px-3 py-2 font-medium text-white/70">Live PnL</th>
            <th
              className="px-3 py-2 font-medium text-white/70"
              title="Delta mark price (same as Terminal — not LTP)"
            >
              Mark price
            </th>
            <th className="px-3 py-2 font-medium text-white/70">Actions</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, idx) => (
            <tr
              key={`${r.token}-${r.side}-${idx}`}
              className="border-b border-white/[0.05] last:border-0 hover:bg-white/[0.02]"
            >
              {showSourceColumn ? (
                <td className="whitespace-nowrap px-3 py-2 text-xs text-white/75">
                  {variant === "follower"
                    ? (r as FollowerRow).userEmail
                    : "ADMIN · MASTER DELTA"}
                </td>
              ) : null}
              <td className="whitespace-nowrap px-3 py-2 tabular-nums text-white/55">
                {fmtTime(r.entryTime)}
              </td>
              <td className="px-3 py-2 font-medium text-white">{r.token}</td>
              <td className="px-3 py-2 text-white/65">{r.side}</td>
              <td className="px-3 py-2 tabular-nums text-white/80">
                {fmtPrice(r.entryPrice)}
              </td>
              <td
                className={`px-3 py-2 tabular-nums font-medium ${
                  r.livePnl != null && r.livePnl >= 0
                    ? "text-emerald-400"
                    : r.livePnl != null
                      ? "text-red-300"
                      : "text-white/55"
                }`}
              >
                {fmtPnl(r.livePnl)}
              </td>
              <td className="px-3 py-2 tabular-nums text-white/80">
                {fmtPrice(r.markPrice)}
              </td>
              <td className="px-3 py-2">
                {r.size != null && Number.isFinite(r.size) && r.size > 0 ? (
                  <button
                    type="button"
                    disabled={
                      closingKey ===
                      `${strategyId}:${r.token}:${r.side}:${variant === "master" ? "master" : closeUserId ?? "follower"}`
                    }
                    onClick={() =>
                      void onCloseTrade({
                        strategyId,
                        userId:
                          variant === "master" ? undefined : closeUserId,
                        symbol: r.token,
                        side: r.side,
                        size: r.size ?? 0,
                        isMaster: variant === "master",
                      })
                    }
                    className="rounded-md border border-red-500/45 bg-red-500/15 px-2.5 py-1 text-xs font-medium text-red-200 transition hover:bg-red-500/25 disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    Close Trade
                  </button>
                ) : (
                  <span className="text-xs text-white/35">—</span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function AdminLiveTradesStrategyTabs({
  strategies,
  activeId,
  onSelect,
}: {
  strategies: StrategySection[];
  activeId: string;
  onSelect: (id: string) => void;
}) {
  if (strategies.length <= 1) return null;

  return (
    <div
      role="tablist"
      aria-label="Active strategies"
      className="flex flex-wrap gap-2 border-b border-glassBorder pb-3"
    >
      {strategies.map((strategy) => {
        const selected = strategy.strategyId === activeId;
        const masterLegs = strategy.masterPositions.length;
        const followers = strategy.subscribers.length;
        return (
          <button
            key={strategy.strategyId}
            type="button"
            role="tab"
            aria-selected={selected}
            onClick={() => onSelect(strategy.strategyId)}
            className={`rounded-lg border px-3 py-2 text-left text-sm transition ${
              selected
                ? "border-primary/50 bg-primary/15 text-white ring-1 ring-primary/30"
                : "border-white/10 bg-white/[0.03] text-white/65 hover:border-white/20 hover:bg-white/[0.06]"
            }`}
          >
            <span className="font-medium">{strategy.strategyTitle}</span>
            <span className="mt-0.5 block text-[10px] tabular-nums text-white/40">
              {masterLegs} master · {followers} follower
              {followers === 1 ? "" : "s"}
            </span>
          </button>
        );
      })}
    </div>
  );
}

export default function AdminLiveTradesPage() {
  const [strategies, setStrategies] = useState<StrategySection[]>([]);
  const [activeStrategyId, setActiveStrategyId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [forbidden, setForbidden] = useState(false);
  const [lastRefreshed, setLastRefreshed] = useState<Date | null>(null);
  const [closingKey, setClosingKey] = useState<string | null>(null);
  const [syncingUserId, setSyncingUserId] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [expandedSubsByStrategy, setExpandedSubsByStrategy] = useState<
    Record<string, Set<string>>
  >({});

  const toggleSubscriberExpanded = useCallback(
    (strategyId: string, userId: string) => {
      setExpandedSubsByStrategy((prev) => {
        const next = { ...prev };
        const current = new Set(next[strategyId] ?? []);
        if (current.has(userId)) current.delete(userId);
        else current.add(userId);
        next[strategyId] = current;
        return next;
      });
    },
    [],
  );

  const ensureExpandedDefaults = useCallback((list: StrategySection[]) => {
    setExpandedSubsByStrategy((prev) => {
      const next = { ...prev };
      for (const s of list) {
        if (!next[s.strategyId]) {
          next[s.strategyId] = new Set(
            s.subscribers.map((u) => u.userId),
          );
        }
      }
      return next;
    });
  }, []);

  const load = useCallback(async (opts?: { silent?: boolean }) => {
    const silent = Boolean(opts?.silent);
    if (!silent) {
      setLoading(true);
      setError(null);
      setForbidden(false);
    } else {
      setIsRefreshing(true);
    }
    const base = resolveAdminApiBase();
    if (!base) {
      if (!silent) {
        setError(
          "NEXT_PUBLIC_API_URL is not set and same-origin /api could not be resolved.",
        );
        setStrategies([]);
        setLoading(false);
      }
      return;
    }
    try {
      const res = await fetch(
        `${base}/admin/live-trades/grouped?t=${Date.now()}`,
        {
          cache: "no-store",
          headers: {
            Authorization: `Bearer ${localStorage.getItem("token") ?? ""}`,
            "Cache-Control": "no-cache",
            Pragma: "no-cache",
          },
        },
      );
      if (res.status === 403) {
        if (!silent) {
          setForbidden(true);
          setStrategies([]);
        }
        return;
      }
      if (!res.ok) {
        const payload: unknown = await res.json().catch(() => null);
        const apiMessage =
          typeof payload === "object" &&
          payload !== null &&
          "message" in payload &&
          typeof (payload as { message: unknown }).message === "string"
            ? (payload as { message: string }).message
            : null;
        throw new Error(apiMessage ?? `Request failed (${res.status})`);
      }
      const data: unknown = await res.json();
      const list = parseStrategyGroups(data);
      setStrategies(list);
      ensureExpandedDefaults(list);
      setLastRefreshed(new Date());
    } catch (e) {
      if (!silent) {
        setError(e instanceof Error ? e.message : "Failed to load");
      }
    } finally {
      if (silent) setIsRefreshing(false);
      else setLoading(false);
    }
  }, [ensureExpandedDefaults]);

  const closeTrade = useCallback(
    async (args: {
      strategyId: string;
      userId?: string;
      symbol: string;
      side: string;
      size: number;
      isMaster: boolean;
    }) => {
      const key = `${args.strategyId}:${args.symbol}:${args.side}:${args.userId ?? "master"}`;
      setClosingKey(key);
      try {
        const base = resolveAdminApiBase();
        const res = await fetch(`${base}/admin/trades/close-manual`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${localStorage.getItem("token") ?? ""}`,
          },
          body: JSON.stringify(args),
        });
        const payload: unknown = await res.json().catch(() => ({}));
        if (!res.ok) {
          const msg =
            typeof payload === "object" &&
            payload !== null &&
            "error" in payload &&
            typeof (payload as { error: unknown }).error === "string"
              ? (payload as { error: string }).error
              : `Close failed (${res.status})`;
          throw new Error(msg);
        }
        await load({ silent: true });
      } catch (e) {
        setError(e instanceof Error ? e.message : "Failed to close trade");
      } finally {
        setClosingKey(null);
      }
    },
    [load],
  );

  const syncUser = useCallback(
    async (strategyId: string, userId: string) => {
      setSyncingUserId(userId);
      try {
        const base = resolveAdminApiBase();
        const res = await fetch(
          `${base}/admin/strategies/${encodeURIComponent(strategyId)}/sync-user/${encodeURIComponent(userId)}`,
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${localStorage.getItem("token") ?? ""}`,
            },
          },
        );
        const payload: unknown = await res.json().catch(() => ({}));
        if (!res.ok) {
          const msg =
            typeof payload === "object" && payload !== null
              ? typeof (payload as { error?: unknown }).error === "string"
                ? (payload as { error: string }).error
                : typeof (payload as { syncError?: unknown }).syncError ===
                    "string"
                  ? (payload as { syncError: string }).syncError
                  : `Sync failed (${res.status})`
              : `Sync failed (${res.status})`;
          throw new Error(msg);
        }
        setToast("Follower synced to master positions.");
        await load({ silent: true });
      } catch (e) {
        setError(e instanceof Error ? e.message : "Failed to sync follower");
      } finally {
        setSyncingUserId(null);
      }
    },
    [load],
  );

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- on-mount fetch is a legitimate effect side-effect
    void load();
  }, [load]);

  useEffect(() => {
    if (strategies.length === 0) {
      setActiveStrategyId(null);
      return;
    }
    setActiveStrategyId((prev) => {
      if (prev && strategies.some((s) => s.strategyId === prev)) return prev;
      return strategies[0]?.strategyId ?? null;
    });
  }, [strategies]);

  useEffect(() => {
    const id = window.setInterval(() => {
      void load({ silent: true });
    }, LIVE_TRADES_REFRESH_MS);
    return () => window.clearInterval(id);
  }, [load]);

  useEffect(() => {
    if (!toast) return;
    const id = window.setTimeout(() => setToast(null), 4000);
    return () => window.clearTimeout(id);
  }, [toast]);

  if (forbidden) {
    return (
      <div className="rounded-xl border border-red-500/35 bg-red-500/10 px-6 py-10 text-center text-sm text-red-100">
        Admin access required.
        <Link href="/dashboard" className="mt-4 block text-primary hover:underline">
          Back to dashboard
        </Link>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-6xl space-y-8">
      <header className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-start gap-3">
          <div className="rounded-xl border border-glassBorder bg-primary/10 p-3">
            <Layers className="h-6 w-6 text-primary" aria-hidden />
          </div>
          <div>
            <h1 className="text-2xl font-semibold tracking-tight text-white md:text-3xl">
              Live trades
            </h1>
            <p className="mt-1 text-sm text-white/55">
              Master positions and active follower grid for all configured
              strategies. Refreshes every {LIVE_TRADES_REFRESH_MS / 1000}s
              without reloading.
            </p>
            {lastRefreshed && !loading ? (
              <p className="mt-1 flex items-center gap-2 text-xs text-white/40">
                {isRefreshing ? (
                  <RefreshCw
                    className="h-3 w-3 animate-spin text-primary"
                    aria-hidden
                  />
                ) : (
                  <Radio className="h-3 w-3 text-emerald-400/80" aria-hidden />
                )}
                Last updated {lastRefreshed.toLocaleTimeString()}
                {isRefreshing ? " · updating…" : ""}
              </p>
            ) : null}
          </div>
        </div>
      </header>

      {toast && (
        <div className="rounded-lg border border-emerald-500/40 bg-emerald-500/10 px-4 py-3 text-sm text-emerald-100">
          {toast}
        </div>
      )}

      {error && (
        <div className="rounded-lg border border-red-500/40 bg-red-500/10 px-4 py-3 text-sm text-red-200">
          {error}
        </div>
      )}

      {loading ? (
        <div className="flex justify-center py-20">
          <Loader2 className="h-10 w-10 animate-spin text-primary" />
        </div>
      ) : strategies.length === 0 && !error ? (
        <p className="rounded-xl border border-glassBorder bg-white/[0.03] px-6 py-12 text-center text-sm text-white/50">
          Future Hedge Strategy is not configured yet.
        </p>
      ) : strategies.length > 0 ? (
        <div className="space-y-4">
          <AdminLiveTradesStrategyTabs
            strategies={strategies}
            activeId={activeStrategyId ?? strategies[0]!.strategyId}
            onSelect={setActiveStrategyId}
          />
          <div className="glass-card min-h-[420px] border border-glassBorder p-5 md:p-6">
            {strategies.map((panel) => {
              const isActive =
                panel.strategyId ===
                (activeStrategyId ?? strategies[0]!.strategyId);
              const expanded =
                expandedSubsByStrategy[panel.strategyId] ??
                new Set(panel.subscribers.map((u) => u.userId));
              return (
                <div key={panel.strategyId} hidden={!isActive}>
                  <StrategyLivePanel
                    strategy={panel}
                    isActiveTab={isActive}
                    expandedSubs={expanded}
                    onToggleSubscriber={(userId) =>
                      toggleSubscriberExpanded(panel.strategyId, userId)
                    }
                    onCloseTrade={closeTrade}
                    closingKey={closingKey}
                    onSyncUser={syncUser}
                    syncingUserId={syncingUserId}
                    onAutoExitSaved={(message, updated) => {
                      setToast(message);
                      if (updated) {
                        setStrategies((prev) =>
                          prev.map((row) =>
                            row.strategyId === panel.strategyId
                              ? { ...row, ...updated }
                              : row,
                          ),
                        );
                      }
                      if (message.includes("saved")) {
                        void load({ silent: true });
                      }
                    }}
                  />
                </div>
              );
            })}
          </div>
        </div>
      ) : null}
    </div>
  );
}
