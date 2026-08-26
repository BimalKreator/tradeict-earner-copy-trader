"use client";

import {
  CheckCircle2,
  Circle,
  Loader2,
  RefreshCw,
  UserCheck,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { adminFetch, buildAdminApiUrl, formatAdminFetchError } from "@/lib/adminAuth";
import { resolveApiBase } from "@/lib/apiBase";
import { fmtUsd } from "@/lib/currency";
import {
  deployedCapitalFromMultiplier,
  multiplierFromDeployedCapital,
} from "@/lib/subscription";

type OnboardingPayload = {
  user: {
    id: string;
    email: string;
    name: string | null;
    status: string;
    copyTradingPaused: boolean;
  };
  exchangeAccount: { id: string; nickname: string; exchange: string } | null;
  connectionTest: {
    success: boolean;
    error: string | null;
    openPositionCount: number | null;
    availableBalanceUsd: number | null;
    apiKeyPrefix: string | null;
  } | null;
  subscription: {
    id: string;
    strategyId: string;
    strategyTitle: string;
    multiplier: number;
    baseCapital: number | null;
    deployedCapital: number | null;
    isActive: boolean;
    status: string;
    profitShareOverride: number | null;
    profitSharePctSnapshot: number | null;
    strategyDefaultProfitShare: number | null;
    effectiveProfitSharePct: number | null;
  } | null;
  availableStrategies: Array<{
    id: string;
    title: string;
    monthlyFee: number;
    profitShare: number;
    baseCapital: number;
  }>;
  checklist: {
    accountActive: boolean;
    deltaKeysConnected: boolean;
    tradingPermissionOk: boolean | null;
    withdrawalDisabled: boolean | null;
    ipWhitelisted: boolean | null;
    subscribedToBotStrategy: boolean;
    capitalAllocated: boolean;
    profitShareConfigured: boolean;
    copyTradingEnabled: boolean;
  };
};

type Props = {
  userId: string;
  onNotice?: (message: string) => void;
  onError?: (message: string) => void;
  onReloadUser?: () => void | Promise<void>;
};

function StepIcon({ done, pending }: { done: boolean; pending?: boolean }) {
  if (pending) return <Loader2 className="h-5 w-5 shrink-0 animate-spin text-sky-300" />;
  if (done) return <CheckCircle2 className="h-5 w-5 shrink-0 text-emerald-400" />;
  return <Circle className="h-5 w-5 shrink-0 text-white/25" />;
}

export function AdminUserOnboardingPanel({
  userId,
  onNotice,
  onError,
  onReloadUser,
}: Props) {
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [data, setData] = useState<OnboardingPayload | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [apiKeyDraft, setApiKeyDraft] = useState("");
  const [apiSecretDraft, setApiSecretDraft] = useState("");
  const [apiNicknameDraft, setApiNicknameDraft] = useState("Primary");
  const [savingKeys, setSavingKeys] = useState(false);

  const [subscribeStrategyId, setSubscribeStrategyId] = useState("");
  const [subscribePaymentMode, setSubscribePaymentMode] = useState<"PAY_LATER" | "PAY_NOW">(
    "PAY_LATER",
  );
  const [subscribeProfitShare, setSubscribeProfitShare] = useState("");
  const [subscribeMultiplier, setSubscribeMultiplier] = useState("1");
  const [subscribing, setSubscribing] = useState(false);

  const [capitalDraft, setCapitalDraft] = useState("");
  const [savingCapital, setSavingCapital] = useState(false);

  const [profitShareDraft, setProfitShareDraft] = useState("");
  const [savingProfitShare, setSavingProfitShare] = useState(false);

  const [activatingAccount, setActivatingAccount] = useState(false);
  const [enablingCopy, setEnablingCopy] = useState(false);

  const loadOnboarding = useCallback(
    async (silent = false) => {
      if (!resolveApiBase() || !userId) return;
      if (silent) setRefreshing(true);
      else setLoading(true);
      setLoadError(null);
      try {
        const path = `/admin/users/${userId}/onboarding`;
        const res = await adminFetch(path);
        if (!res.ok) {
          throw new Error(formatAdminFetchError("onboarding", res, buildAdminApiUrl(path)));
        }
        const payload = (await res.json()) as OnboardingPayload;
        setData(payload);
        if (payload.subscription) {
          setCapitalDraft(
            String(
              payload.subscription.deployedCapital ??
                deployedCapitalFromMultiplier(
                  payload.subscription.multiplier,
                  payload.subscription.baseCapital ?? 300,
                ),
            ),
          );
          setProfitShareDraft(
            payload.subscription.profitShareOverride != null
              ? String(payload.subscription.profitShareOverride)
              : "",
          );
        }
        if (!subscribeStrategyId && payload.availableStrategies[0]?.id) {
          setSubscribeStrategyId(payload.availableStrategies[0].id);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Failed to load onboarding";
        setLoadError(msg);
        onError?.(msg);
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
    },
    [userId, onError, subscribeStrategyId],
  );

  useEffect(() => {
    void loadOnboarding();
  }, [loadOnboarding]);

  const completedCount = useMemo(() => {
    if (!data) return 0;
    const c = data.checklist;
    const flags = [
      c.accountActive,
      c.deltaKeysConnected,
      c.tradingPermissionOk === true && c.withdrawalDisabled === true,
      c.ipWhitelisted === true,
      c.subscribedToBotStrategy,
      c.capitalAllocated,
      c.profitShareConfigured,
      c.copyTradingEnabled,
    ];
    return flags.filter(Boolean).length;
  }, [data]);

  async function activateAccount() {
    setActivatingAccount(true);
    try {
      const path = `/admin/users/${userId}/status`;
      const res = await adminFetch(path, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "ACTIVE" }),
      });
      if (!res.ok) {
        throw new Error(formatAdminFetchError("activate account", res, buildAdminApiUrl(path)));
      }
      onNotice?.("Account activated.");
      await loadOnboarding(true);
      await onReloadUser?.();
    } catch (err) {
      onError?.(err instanceof Error ? err.message : "Failed to activate account");
    } finally {
      setActivatingAccount(false);
    }
  }

  async function saveApiKeys() {
    if (!apiKeyDraft.trim() || !apiSecretDraft.trim()) {
      onError?.("API key and secret are required.");
      return;
    }
    setSavingKeys(true);
    try {
      const path = `/admin/users/${userId}/api-keys`;
      const res = await adminFetch(path, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          apiKey: apiKeyDraft.trim(),
          apiSecret: apiSecretDraft.trim(),
          nickname: apiNicknameDraft.trim() || "Primary",
        }),
      });
      const body = (await res.json().catch(() => ({}))) as {
        error?: string;
        connectionTest?: { success?: boolean; error?: string | null };
      };
      if (!res.ok) {
        throw new Error(body.error ?? formatAdminFetchError("save API keys", res, buildAdminApiUrl(path)));
      }
      if (body.connectionTest?.success) {
        onNotice?.("Delta API keys saved and connection verified.");
      } else {
        onNotice?.(
          `Keys saved but connection test failed: ${body.connectionTest?.error ?? "unknown error"}`,
        );
      }
      setApiKeyDraft("");
      setApiSecretDraft("");
      await loadOnboarding(true);
      await onReloadUser?.();
    } catch (err) {
      onError?.(err instanceof Error ? err.message : "Failed to save API keys");
    } finally {
      setSavingKeys(false);
    }
  }

  async function runSubscribe() {
    if (!subscribeStrategyId) {
      onError?.("Select a strategy.");
      return;
    }
    setSubscribing(true);
    try {
      const body: Record<string, unknown> = {
        strategyId: subscribeStrategyId,
        paymentMode: subscribePaymentMode,
      };
      const mult = Number(subscribeMultiplier);
      if (Number.isFinite(mult) && mult > 0) body.multiplier = mult;
      if (subscribeProfitShare.trim()) {
        body.profitSharePct = Number(subscribeProfitShare);
      }
      const path = `/admin/users/${userId}/subscribe`;
      const res = await adminFetch(path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const payload = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        throw new Error(payload.error ?? formatAdminFetchError("subscribe", res, buildAdminApiUrl(path)));
      }
      onNotice?.("Customer subscribed to strategy.");
      await loadOnboarding(true);
      await onReloadUser?.();
    } catch (err) {
      onError?.(err instanceof Error ? err.message : "Subscribe failed");
    } finally {
      setSubscribing(false);
    }
  }

  async function saveCapitalAllocation() {
    const sub = data?.subscription;
    if (!sub) {
      onError?.("Subscribe to a bot strategy first.");
      return;
    }
    const deployed = Number(capitalDraft);
    if (!Number.isFinite(deployed) || deployed <= 0) {
      onError?.("Allocated capital must be a positive number.");
      return;
    }
    setSavingCapital(true);
    try {
      const path = `/admin/strategies/${encodeURIComponent(sub.strategyId)}/subscribers/${encodeURIComponent(userId)}`;
      const res = await adminFetch(path, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ deployedCapital: deployed }),
      });
      const payload = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        throw new Error(payload.error ?? formatAdminFetchError("capital", res, buildAdminApiUrl(path)));
      }
      onNotice?.("Capital allocation updated.");
      await loadOnboarding(true);
    } catch (err) {
      onError?.(err instanceof Error ? err.message : "Failed to save capital");
    } finally {
      setSavingCapital(false);
    }
  }

  async function saveProfitShare() {
    setSavingProfitShare(true);
    try {
      const path = `/admin/revenue/user/${userId}/profit-share`;
      const val = profitShareDraft.trim();
      const res = await adminFetch(path, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          profitShareOverride: val === "" ? null : Number(val),
        }),
      });
      const payload = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        throw new Error(
          payload.error ?? formatAdminFetchError("profit share", res, buildAdminApiUrl(path)),
        );
      }
      onNotice?.("Profit share override saved.");
      await loadOnboarding(true);
    } catch (err) {
      onError?.(err instanceof Error ? err.message : "Failed to save profit share");
    } finally {
      setSavingProfitShare(false);
    }
  }

  async function enableCopyTrading() {
    const sub = data?.subscription;
    setEnablingCopy(true);
    try {
      const copyPath = `/admin/users/${userId}/copy-trading`;
      const copyRes = await adminFetch(copyPath, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ paused: false }),
      });
      if (!copyRes.ok) {
        throw new Error(formatAdminFetchError("copy trading", copyRes, buildAdminApiUrl(copyPath)));
      }
      if (sub && !sub.isActive) {
        const subPath = `/admin/strategies/${encodeURIComponent(sub.strategyId)}/subscribers/${encodeURIComponent(userId)}`;
        const subRes = await adminFetch(subPath, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ isActive: true }),
        });
        if (!subRes.ok) {
          throw new Error(formatAdminFetchError("deploy subscription", subRes, buildAdminApiUrl(subPath)));
        }
      }
      onNotice?.("Copy trading enabled.");
      await loadOnboarding(true);
      await onReloadUser?.();
    } catch (err) {
      onError?.(err instanceof Error ? err.message : "Failed to enable copy trading");
    } finally {
      setEnablingCopy(false);
    }
  }

  const lotRatioLabel = useMemo(() => {
    const sub = data?.subscription;
    if (!sub?.baseCapital) return null;
    const mult =
      sub.multiplier ??
      multiplierFromDeployedCapital(
        Number(capitalDraft) || (sub.deployedCapital ?? 0),
        sub.baseCapital,
      );
    if (!Number.isFinite(mult) || mult <= 0) return null;
    return `Master 1 lot → customer ${mult.toFixed(2)} lot(s) · ${fmtUsd(sub.deployedCapital ?? deployedCapitalFromMultiplier(mult, sub.baseCapital))} allocated`;
  }, [data, capitalDraft]);

  if (loading && !data) {
    return (
      <div className="flex justify-center rounded-xl border border-emerald-500/25 bg-emerald-500/[0.03] p-8">
        <Loader2 className="h-6 w-6 animate-spin text-white/30" />
      </div>
    );
  }

  const checklist = data?.checklist;
  const conn = data?.connectionTest;
  const sub = data?.subscription;

  return (
    <div className="space-y-4 rounded-xl border border-emerald-500/25 bg-emerald-500/[0.03] p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2 text-emerald-300">
            <UserCheck className="h-4 w-4" />
            <h2 className="text-lg font-semibold text-white">Customer onboarding</h2>
          </div>
          <p className="mt-1 text-sm text-white/55">
            End-to-end setup from one place — {completedCount}/8 steps complete.
          </p>
        </div>
        <button
          type="button"
          onClick={() => void loadOnboarding(true)}
          disabled={refreshing}
          className="inline-flex items-center gap-1.5 rounded-lg border border-white/15 px-3 py-1.5 text-xs text-white/70 hover:bg-white/5 disabled:opacity-60"
        >
          <RefreshCw className={`h-3.5 w-3.5 ${refreshing ? "animate-spin" : ""}`} />
          Refresh status
        </button>
      </div>

      {loadError ? <p className="text-sm text-amber-200">{loadError}</p> : null}

      <ol className="space-y-3">
        {/* Account active */}
        <li className="rounded-lg border border-white/10 bg-black/25 p-3">
          <div className="flex items-start gap-3">
            <StepIcon done={Boolean(checklist?.accountActive)} />
            <div className="min-w-0 flex-1">
              <p className="font-medium text-white">Account active</p>
              <p className="text-xs text-white/45">
                Status: {data?.user.status ?? "—"}
              </p>
              {!checklist?.accountActive ? (
                <button
                  type="button"
                  onClick={() => void activateAccount()}
                  disabled={activatingAccount}
                  className="mt-2 rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-white disabled:opacity-60"
                >
                  {activatingAccount ? "Activating…" : "Activate account"}
                </button>
              ) : null}
            </div>
          </div>
        </li>

        {/* Delta keys */}
        <li className="rounded-lg border border-white/10 bg-black/25 p-3">
          <div className="flex items-start gap-3">
            <StepIcon done={Boolean(checklist?.deltaKeysConnected)} pending={savingKeys} />
            <div className="min-w-0 flex-1 space-y-2">
              <p className="font-medium text-white">Delta API keys connected</p>
              {data?.exchangeAccount ? (
                <p className="text-xs text-white/45">
                  {data.exchangeAccount.nickname} ({data.exchangeAccount.exchange})
                  {conn?.apiKeyPrefix ? ` · ${conn.apiKeyPrefix}` : ""}
                </p>
              ) : (
                <p className="text-xs text-white/45">No exchange account on file.</p>
              )}
              {conn && !conn.success && conn.error ? (
                <p className="text-xs text-amber-200">{conn.error}</p>
              ) : null}
              {conn?.success ? (
                <p className="text-xs text-emerald-300/90">
                  Connection OK
                  {conn.openPositionCount != null ? ` · ${conn.openPositionCount} open position(s)` : ""}
                  {conn.availableBalanceUsd != null
                    ? ` · ${fmtUsd(conn.availableBalanceUsd)} available`
                    : ""}
                </p>
              ) : null}
              <div className="grid gap-2 sm:grid-cols-2">
                <input
                  value={apiNicknameDraft}
                  onChange={(e) => setApiNicknameDraft(e.target.value)}
                  placeholder="Nickname"
                  className="rounded border border-white/15 bg-black/40 px-2 py-1.5 text-xs text-white"
                />
                <input
                  value={apiKeyDraft}
                  onChange={(e) => setApiKeyDraft(e.target.value)}
                  placeholder="Paste Delta API key"
                  className="rounded border border-white/15 bg-black/40 px-2 py-1.5 text-xs text-white"
                />
                <input
                  value={apiSecretDraft}
                  onChange={(e) => setApiSecretDraft(e.target.value)}
                  placeholder="Paste Delta API secret"
                  type="password"
                  autoComplete="off"
                  className="rounded border border-white/15 bg-black/40 px-2 py-1.5 text-xs text-white sm:col-span-2"
                />
              </div>
              <button
                type="button"
                onClick={() => void saveApiKeys()}
                disabled={savingKeys}
                className="rounded-md border border-emerald-500/40 bg-emerald-500/15 px-3 py-1.5 text-xs font-medium text-emerald-100 disabled:opacity-60"
              >
                {savingKeys ? "Saving & testing…" : "Save keys & test connection"}
              </button>
            </div>
          </div>
        </li>

        {/* Trading permission + withdrawal */}
        <li className="rounded-lg border border-white/10 bg-black/25 p-3">
          <div className="flex items-start gap-3">
            <StepIcon
              done={
                checklist?.tradingPermissionOk === true &&
                checklist?.withdrawalDisabled === true
              }
            />
            <div className="min-w-0 flex-1">
              <p className="font-medium text-white">Trading permission ON, withdrawal OFF</p>
              <p className="text-xs text-white/45">
                {checklist?.deltaKeysConnected
                  ? "Verified via successful Delta connection (ensure withdrawal is disabled on the key in Delta Exchange)."
                  : checklist?.tradingPermissionOk === false
                    ? "Connection failed — check trading permissions on the Delta API key."
                    : "Connect API keys first."}
              </p>
            </div>
          </div>
        </li>

        {/* IP whitelist */}
        <li className="rounded-lg border border-white/10 bg-black/25 p-3">
          <div className="flex items-start gap-3">
            <StepIcon done={checklist?.ipWhitelisted === true} />
            <div className="min-w-0 flex-1">
              <p className="font-medium text-white">IP whitelisted</p>
              <p className="text-xs text-white/45">
                {checklist?.ipWhitelisted === true
                  ? "Connection succeeded — IP appears whitelisted."
                  : checklist?.ipWhitelisted === false
                    ? "IP not whitelisted — add server IP on Delta Exchange India."
                    : conn?.error
                      ? conn.error
                      : "Save keys and run connection test."}
              </p>
            </div>
          </div>
        </li>

        {/* Subscribe */}
        <li className="rounded-lg border border-white/10 bg-black/25 p-3">
          <div className="flex items-start gap-3">
            <StepIcon done={Boolean(checklist?.subscribedToBotStrategy)} pending={subscribing} />
            <div className="min-w-0 flex-1 space-y-2">
              <p className="font-medium text-white">Subscribed to a bot strategy</p>
              {sub ? (
                <p className="text-xs text-emerald-300/90">
                  {sub.strategyTitle} · status {sub.status}
                </p>
              ) : (
                <>
                  <div className="grid gap-2 sm:grid-cols-2">
                    <select
                      value={subscribeStrategyId}
                      onChange={(e) => setSubscribeStrategyId(e.target.value)}
                      className="rounded border border-white/15 bg-black/40 px-2 py-1.5 text-xs text-white"
                    >
                      <option value="">Select strategy…</option>
                      {(data?.availableStrategies ?? []).map((s) => (
                        <option key={s.id} value={s.id}>
                          {s.title} (₹{s.monthlyFee}/mo)
                        </option>
                      ))}
                    </select>
                    <select
                      value={subscribePaymentMode}
                      onChange={(e) =>
                        setSubscribePaymentMode(e.target.value as "PAY_LATER" | "PAY_NOW")
                      }
                      className="rounded border border-white/15 bg-black/40 px-2 py-1.5 text-xs text-white"
                    >
                      <option value="PAY_LATER">Pay later (sales-led)</option>
                      <option value="PAY_NOW">Pay now (requires customer checkout)</option>
                    </select>
                    <input
                      value={subscribeMultiplier}
                      onChange={(e) => setSubscribeMultiplier(e.target.value)}
                      placeholder="Multiplier (optional, default 1)"
                      className="rounded border border-white/15 bg-black/40 px-2 py-1.5 text-xs text-white"
                    />
                    <input
                      value={subscribeProfitShare}
                      onChange={(e) => setSubscribeProfitShare(e.target.value)}
                      placeholder="Profit share % override (optional)"
                      className="rounded border border-white/15 bg-black/40 px-2 py-1.5 text-xs text-white"
                    />
                  </div>
                  <button
                    type="button"
                    onClick={() => void runSubscribe()}
                    disabled={subscribing || !subscribeStrategyId}
                    className="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-white disabled:opacity-60"
                  >
                    {subscribing ? "Subscribing…" : "Subscribe customer"}
                  </button>
                </>
              )}
            </div>
          </div>
        </li>

        {/* Capital allocation */}
        <li className="rounded-lg border border-white/10 bg-black/25 p-3">
          <div className="flex items-start gap-3">
            <StepIcon done={Boolean(checklist?.capitalAllocated)} pending={savingCapital} />
            <div className="min-w-0 flex-1 space-y-2">
              <p className="font-medium text-white">Capital allocated</p>
              {lotRatioLabel ? (
                <p className="text-xs text-sky-200/90">{lotRatioLabel}</p>
              ) : (
                <p className="text-xs text-white/45">Set deployed capital after subscribing.</p>
              )}
              {sub ? (
                <div className="flex flex-wrap items-end gap-2">
                  <label className="text-xs text-white/55">
                    Deployed capital (USD)
                    <input
                      value={capitalDraft}
                      onChange={(e) => setCapitalDraft(e.target.value)}
                      className="mt-1 block w-36 rounded border border-white/15 bg-black/40 px-2 py-1.5 text-xs text-white"
                    />
                  </label>
                  <button
                    type="button"
                    onClick={() => void saveCapitalAllocation()}
                    disabled={savingCapital}
                    className="rounded-md border border-sky-500/40 bg-sky-500/15 px-3 py-1.5 text-xs font-medium text-sky-100 disabled:opacity-60"
                  >
                    {savingCapital ? "Saving…" : "Save allocation"}
                  </button>
                </div>
              ) : null}
            </div>
          </div>
        </li>

        {/* Profit share */}
        <li className="rounded-lg border border-white/10 bg-black/25 p-3">
          <div className="flex items-start gap-3">
            <StepIcon done={Boolean(checklist?.profitShareConfigured)} pending={savingProfitShare} />
            <div className="min-w-0 flex-1 space-y-2">
              <p className="font-medium text-white">Profit share % set</p>
              <p className="text-xs text-white/45">
                {sub
                  ? sub.profitShareOverride != null
                    ? `Override: ${sub.profitShareOverride}% (snapshot ${sub.profitSharePctSnapshot ?? "—"}%, strategy default ${sub.strategyDefaultProfitShare ?? "—"}%)`
                    : `Using strategy default ${sub.effectiveProfitSharePct ?? sub.strategyDefaultProfitShare ?? "—"}% (snapshot ${sub.profitSharePctSnapshot ?? "—"}%)`
                  : "Subscribe first, then set override if needed."}
              </p>
              {sub ? (
                <div className="flex flex-wrap items-end gap-2">
                  <label className="text-xs text-white/55">
                    Override % (blank = strategy default)
                    <input
                      value={profitShareDraft}
                      onChange={(e) => setProfitShareDraft(e.target.value)}
                      placeholder={String(sub.strategyDefaultProfitShare ?? "")}
                      className="mt-1 block w-28 rounded border border-white/15 bg-black/40 px-2 py-1.5 text-xs text-white"
                    />
                  </label>
                  <button
                    type="button"
                    onClick={() => void saveProfitShare()}
                    disabled={savingProfitShare}
                    className="rounded-md border border-violet-500/40 bg-violet-500/15 px-3 py-1.5 text-xs font-medium text-violet-100 disabled:opacity-60"
                  >
                    {savingProfitShare ? "Saving…" : "Save profit share"}
                  </button>
                </div>
              ) : null}
            </div>
          </div>
        </li>

        {/* Copy trading */}
        <li className="rounded-lg border border-white/10 bg-black/25 p-3">
          <div className="flex items-start gap-3">
            <StepIcon done={Boolean(checklist?.copyTradingEnabled)} pending={enablingCopy} />
            <div className="min-w-0 flex-1">
              <p className="font-medium text-white">Copy trading enabled</p>
              <p className="text-xs text-white/45">
                {data?.user.copyTradingPaused
                  ? "User-level copy trading is paused."
                  : sub && !sub.isActive
                    ? "Subscription exists but deploy (isActive) is off."
                    : checklist?.copyTradingEnabled
                      ? "Copy trading is live."
                      : "Enable after keys, subscribe, and capital are set."}
              </p>
              {!checklist?.copyTradingEnabled && sub ? (
                <button
                  type="button"
                  onClick={() => void enableCopyTrading()}
                  disabled={enablingCopy}
                  className="mt-2 rounded-md bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white disabled:opacity-60"
                >
                  {enablingCopy ? "Enabling…" : "Enable copy trading"}
                </button>
              ) : null}
            </div>
          </div>
        </li>
      </ol>
    </div>
  );
}
