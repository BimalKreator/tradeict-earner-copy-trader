"use client";

import { KeyRound, Loader2, PlugZap, Trash2 } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";

const ENV_API_BASE =
  process.env.NEXT_PUBLIC_API_URL?.trim().replace(/\/$/, "") ?? "";

function resolveApiBase(): string {
  if (ENV_API_BASE) return ENV_API_BASE;
  if (typeof window !== "undefined") {
    return `${window.location.origin.replace(/\/$/, "")}/api`;
  }
  return "";
}

type ExchangeAccountRow = {
  id: string;
  nickname: string;
  exchange: string;
  createdAt: string;
};

export default function DashboardSettingsPage() {
  const [accounts, setAccounts] = useState<ExchangeAccountRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [unauthorized, setUnauthorized] = useState(false);

  const [nickname, setNickname] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [apiSecret, setApiSecret] = useState("");
  const [exchange, setExchange] = useState("Delta");
  const [adding, setAdding] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [testingId, setTestingId] = useState<string | null>(null);
  const [toast, setToast] = useState<{
    message: string;
    variant: "success" | "error";
  } | null>(null);

  const token =
    typeof window !== "undefined" ? localStorage.getItem("token") : null;

  const loadAccounts = useCallback(async () => {
    setError(null);
    if (!token) {
      setUnauthorized(true);
      setLoading(false);
      setAccounts([]);
      return;
    }
    setUnauthorized(false);
    setLoading(true);
    try {
      const base = resolveApiBase();
      const res = await fetch(`${base}/exchange-accounts`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.status === 401) {
        setUnauthorized(true);
        setAccounts([]);
        return;
      }
      if (!res.ok) throw new Error(`Failed to load keys (${res.status})`);
      const data: unknown = await res.json();
      const list =
        typeof data === "object" &&
        data !== null &&
        "accounts" in data &&
        Array.isArray((data as { accounts: unknown }).accounts)
          ? ((data as { accounts: ExchangeAccountRow[] }).accounts)
          : [];
      setAccounts(list);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load accounts");
      setAccounts([]);
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => {
    void loadAccounts();
  }, [loadAccounts]);

  async function handleAdd(e: React.FormEvent) {
    e.preventDefault();
    setFormError(null);
    if (!token) {
      setUnauthorized(true);
      return;
    }
    const nick = nickname.trim();
    const key = apiKey.trim();
    const secret = apiSecret.trim();
    if (!nick || !key || !secret) {
      setFormError("Nickname, API key, and API secret are required.");
      return;
    }
    setAdding(true);
    try {
      const base = resolveApiBase();
      const res = await fetch(`${base}/exchange-accounts`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          nickname: nick,
          apiKey: key,
          apiSecret: secret,
          exchange: exchange.trim() || "Delta",
        }),
      });
      const body: unknown = await res.json().catch(() => ({}));
      if (!res.ok) {
        const msg =
          typeof body === "object" &&
          body !== null &&
          "error" in body &&
          typeof (body as { error?: unknown }).error === "string"
            ? (body as { error: string }).error
            : `Could not add (${res.status})`;
        throw new Error(msg);
      }
      setNickname("");
      setApiKey("");
      setApiSecret("");
      setExchange("Delta");
      await loadAccounts();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : "Add failed");
    } finally {
      setAdding(false);
    }
  }

  async function handleDelete(id: string) {
    if (!token) return;
    setDeletingId(id);
    setError(null);
    try {
      const base = resolveApiBase();
      const res = await fetch(
        `${base}/exchange-accounts/${encodeURIComponent(id)}`,
        {
          method: "DELETE",
          headers: { Authorization: `Bearer ${token}` },
        },
      );
      if (res.status === 401) {
        setUnauthorized(true);
        return;
      }
      if (!res.ok && res.status !== 204) {
        const body: unknown = await res.json().catch(() => ({}));
        const msg =
          typeof body === "object" &&
          body !== null &&
          "error" in body &&
          typeof (body as { error?: unknown }).error === "string"
            ? (body as { error: string }).error
            : `Delete failed (${res.status})`;
        throw new Error(msg);
      }
      await loadAccounts();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Delete failed");
    } finally {
      setDeletingId(null);
    }
  }

  async function handleTestConnection(id: string) {
    if (!token) {
      setUnauthorized(true);
      return;
    }
    setTestingId(id);
    setToast(null);
    try {
      const base = resolveApiBase();
      const res = await fetch(`${base}/exchange-accounts/test`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ exchangeAccountId: id }),
      });
      const body: unknown = await res.json().catch(() => ({}));
      if (res.status === 401) {
        setUnauthorized(true);
        return;
      }
      if (res.status === 404) {
        const msg =
          typeof body === "object" &&
          body !== null &&
          "error" in body &&
          typeof (body as { error?: unknown }).error === "string"
            ? (body as { error: string }).error
            : "Account not found";
        setToast({ message: msg, variant: "error" });
        return;
      }
      if (!res.ok && res.status !== 200) {
        const msg =
          typeof body === "object" &&
          body !== null &&
          "error" in body &&
          typeof (body as { error?: unknown }).error === "string"
            ? (body as { error: string }).error
            : `Request failed (${res.status})`;
        setToast({ message: msg, variant: "error" });
        return;
      }
      const ok =
        typeof body === "object" &&
        body !== null &&
        "success" in body &&
        (body as { success?: unknown }).success === true;
      const errMsg =
        typeof body === "object" &&
        body !== null &&
        "error" in body &&
        typeof (body as { error?: unknown }).error === "string"
          ? (body as { error: string }).error
          : `Request failed (${res.status})`;
      if (ok) {
        setToast({
          message: "Connection OK — Delta API responded successfully.",
          variant: "success",
        });
      } else {
        setToast({ message: errMsg, variant: "error" });
      }
    } catch (e) {
      setToast({
        message: e instanceof Error ? e.message : "Connection test failed",
        variant: "error",
      });
    } finally {
      setTestingId(null);
    }
  }

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 4800);
    return () => clearTimeout(t);
  }, [toast]);

  if (unauthorized) {
    return (
      <div className="rounded-xl border border-amber-500/35 bg-amber-500/10 px-6 py-10 text-center">
        <p className="text-sm text-white/70">Sign in to manage settings.</p>
        <Link
          href="/login"
          className="mt-4 inline-flex rounded-lg bg-primary px-5 py-2.5 text-sm font-medium text-white hover:bg-primary/90"
        >
          Go to login
        </Link>
      </div>
    );
  }

  return (
    <div className="space-y-10">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight text-white md:text-3xl">
          Settings
        </h1>
        <p className="mt-2 text-sm text-white/55">
          Manage Delta Exchange API credentials used when you subscribe to strategies.
        </p>
      </header>

      {error && (
        <div className="rounded-lg border border-red-500/40 bg-red-500/10 px-4 py-3 text-sm text-red-200">
          {error}
        </div>
      )}

      <section className="glass-card border border-glassBorder p-6 md:p-8">
        <div className="flex items-center gap-2">
          <KeyRound className="h-5 w-5 text-primary/85" aria-hidden />
          <h2 className="text-lg font-semibold text-white">
            Delta Exchange API keys
          </h2>
        </div>
        <p className="mt-2 text-xs text-white/45">
          Stored as exchange accounts (nickname + keys). Secrets are not shown again after saving.
          Use a dedicated API key with minimal permissions where possible.
        </p>

        {loading ? (
          <div className="mt-10 flex justify-center py-12">
            <Loader2 className="h-10 w-10 animate-spin text-primary" aria-hidden />
          </div>
        ) : (
          <>
            {accounts.length > 0 ? (
              <ul className="mt-8 divide-y divide-white/[0.06] rounded-xl border border-white/[0.08] bg-black/20">
                {accounts.map((a) => (
                  <li
                    key={a.id}
                    className="flex flex-col gap-3 px-4 py-4 sm:flex-row sm:items-center sm:justify-between"
                  >
                    <div>
                      <p className="font-medium text-white">{a.nickname}</p>
                      <p className="mt-1 text-xs text-white/45">
                        {a.exchange} · added{" "}
                        {new Date(a.createdAt).toLocaleDateString()}
                      </p>
                    </div>
                    <div className="flex flex-wrap items-center gap-2 sm:justify-end">
                      <button
                        type="button"
                        disabled={testingId === a.id}
                        onClick={() => void handleTestConnection(a.id)}
                        className="inline-flex items-center justify-center gap-2 rounded-lg border border-primary/40 bg-primary/10 px-4 py-2 text-sm font-medium text-primary transition hover:bg-primary/15 disabled:opacity-50"
                      >
                        <PlugZap className="h-4 w-4" aria-hidden />
                        {testingId === a.id ? "Testing…" : "Test connection"}
                      </button>
                    <button
                      type="button"
                      disabled={deletingId === a.id}
                      onClick={() => void handleDelete(a.id)}
                      className="inline-flex items-center justify-center gap-2 rounded-lg border border-red-500/35 bg-red-500/10 px-4 py-2 text-sm font-medium text-red-200 transition hover:bg-red-500/15 disabled:opacity-50"
                    >
                      <Trash2 className="h-4 w-4" aria-hidden />
                      {deletingId === a.id ? "Removing…" : "Remove"}
                    </button>
                    </div>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mt-8 rounded-lg border border-white/[0.08] bg-black/20 px-4 py-6 text-center text-sm text-white/50">
                No API keys yet. Add one below to link copy-trading subscriptions.
              </p>
            )}

            <form className="mt-10 space-y-5 border-t border-white/[0.06] pt-10" onSubmit={handleAdd}>
              <h3 className="text-sm font-semibold text-white">Add API key</h3>
              {formError && (
                <div className="rounded-lg border border-red-500/40 bg-red-500/10 px-4 py-3 text-sm text-red-200">
                  {formError}
                </div>
              )}
              <label className="block">
                <span className="text-xs font-medium text-white/60">Nickname</span>
                <input
                  type="text"
                  value={nickname}
                  onChange={(e) => setNickname(e.target.value)}
                  className="mt-2 w-full rounded-lg border border-glassBorder bg-black/40 px-4 py-3 text-sm text-white outline-none ring-primary/25 focus:ring-2"
                  placeholder="e.g. Main Delta"
                  autoComplete="off"
                />
              </label>
              <label className="block">
                <span className="text-xs font-medium text-white/60">Exchange</span>
                <input
                  type="text"
                  value={exchange}
                  onChange={(e) => setExchange(e.target.value)}
                  className="mt-2 w-full rounded-lg border border-glassBorder bg-black/40 px-4 py-3 text-sm text-white outline-none ring-primary/25 focus:ring-2"
                  placeholder="Delta"
                  autoComplete="off"
                />
              </label>
              <label className="block">
                <span className="text-xs font-medium text-white/60">API key</span>
                <input
                  type="password"
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  className="mt-2 w-full rounded-lg border border-glassBorder bg-black/40 px-4 py-3 text-sm text-white outline-none ring-primary/25 focus:ring-2"
                  placeholder="Paste API key"
                  autoComplete="off"
                />
              </label>
              <label className="block">
                <span className="text-xs font-medium text-white/60">API secret</span>
                <input
                  type="password"
                  value={apiSecret}
                  onChange={(e) => setApiSecret(e.target.value)}
                  className="mt-2 w-full rounded-lg border border-glassBorder bg-black/40 px-4 py-3 text-sm text-white outline-none ring-primary/25 focus:ring-2"
                  placeholder="Paste API secret"
                  autoComplete="off"
                />
              </label>
              <div className="flex justify-end">
                <button
                  type="submit"
                  disabled={adding}
                  className="rounded-lg bg-primary px-6 py-2.5 text-sm font-medium text-white shadow-lg shadow-primary/20 disabled:opacity-50"
                >
                  {adding ? "Saving…" : "Save API key"}
                </button>
              </div>
            </form>
          </>
        )}
      </section>

      {toast && (
        <div
          role="status"
          aria-live="polite"
          className="fixed bottom-6 left-1/2 z-50 w-[calc(100%-2rem)] max-w-md -translate-x-1/2 shadow-2xl"
        >
          <div
            className={`glass-card border px-5 py-4 text-center text-sm font-medium shadow-2xl ${
              toast.variant === "success"
                ? "border-emerald-500/40 bg-emerald-500/15 text-emerald-100"
                : "border-red-500/40 bg-red-500/15 text-red-100"
            }`}
          >
            {toast.message}
          </div>
        </div>
      )}
    </div>
  );
}
