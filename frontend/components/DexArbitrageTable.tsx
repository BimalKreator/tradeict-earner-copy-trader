"use client";

import { ArrowUpDown, Loader2, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

const API_BASE = process.env.NEXT_PUBLIC_API_URL?.trim().replace(/\/$/, "") ?? "";

export type DexArbitrageRow = {
  token: string;
  tokenName: string;
  basePrice: number;
  lowestPrice: number;
  lowestDex: string;
  highestPrice: number;
  highestDex: string;
  spreadUsd: number;
  spreadPercentage: number;
};

type DexArbitrageResponse = {
  updatedAt: string;
  cacheTtlSeconds: number;
  source: string;
  fromCache?: boolean;
  rows: DexArbitrageRow[];
};

type SortKey =
  | "token"
  | "lowestPrice"
  | "highestPrice"
  | "spreadUsd"
  | "spreadPercentage";

const usdFmt = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 6,
});

const pctFmt = new Intl.NumberFormat("en-US", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

function fmtUsd(n: number): string {
  if (!Number.isFinite(n)) return "—";
  if (n >= 1) return usdFmt.format(n);
  return `$${n.toFixed(6)}`;
}

function tokenIconUrl(symbol: string): string {
  return `https://assets.coincap.io/assets/icons/${symbol.toLowerCase()}@2x.png`;
}

function TokenCell({ symbol, name }: { symbol: string; name: string }) {
  const [imgErr, setImgErr] = useState(false);
  return (
    <div className="flex items-center gap-3">
      {!imgErr ? (
        <img
          src={tokenIconUrl(symbol)}
          alt=""
          width={28}
          height={28}
          className="h-7 w-7 rounded-full bg-slate-800 object-cover"
          onError={() => setImgErr(true)}
        />
      ) : (
        <span className="flex h-7 w-7 items-center justify-center rounded-full bg-primary/20 text-xs font-semibold text-primary">
          {symbol.slice(0, 2)}
        </span>
      )}
      <span>
        <span className="font-medium text-white">{symbol}</span>
        <span className="block text-xs text-slate-500">{name}</span>
      </span>
    </div>
  );
}

function SortHeader({
  label,
  sortKey,
  activeKey,
  dir,
  onSort,
  align = "left",
}: {
  label: string;
  sortKey: SortKey;
  activeKey: SortKey;
  dir: "asc" | "desc";
  onSort: (k: SortKey) => void;
  align?: "left" | "right";
}) {
  const active = activeKey === sortKey;
  return (
    <th className={`px-4 py-3 font-medium ${align === "right" ? "text-right" : "text-left"}`}>
      <button
        type="button"
        onClick={() => onSort(sortKey)}
        className={`inline-flex items-center gap-1 text-xs uppercase tracking-wider transition hover:text-white ${
          active ? "text-cyan-400" : "text-slate-500"
        } ${align === "right" ? "ml-auto" : ""}`}
      >
        {label}
        <ArrowUpDown className={`h-3.5 w-3.5 ${active ? "opacity-100" : "opacity-40"}`} />
        {active ? (
          <span className="sr-only">{dir === "asc" ? "ascending" : "descending"}</span>
        ) : null}
      </button>
    </th>
  );
}

export function DexArbitrageTable() {
  const [rows, setRows] = useState<DexArbitrageRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [meta, setMeta] = useState<{
    updatedAt: string;
    source: string;
    fromCache?: boolean;
  } | null>(null);
  const [sortKey, setSortKey] = useState<SortKey>("spreadPercentage");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");

  const load = useCallback(async (forceRefresh: boolean) => {
    if (forceRefresh) setRefreshing(true);
    else setLoading(true);
    setError(null);
    try {
      const token = localStorage.getItem("token");
      const qs = forceRefresh ? "?refresh=1" : "";
      const res = await fetch(`${API_BASE}/arbitrage/dex${qs}`, {
        headers: { Authorization: `Bearer ${token ?? ""}` },
        cache: "no-store",
      });
      if (!res.ok) throw new Error(`Failed to load spreads (${res.status})`);
      const data = (await res.json()) as DexArbitrageResponse;
      setRows(data.rows ?? []);
      setMeta({
        updatedAt: data.updatedAt,
        source: data.source,
        fromCache: data.fromCache,
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load arbitrage data");
      setRows([]);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void load(false);
  }, [load]);

  function handleSort(key: SortKey) {
    if (sortKey === key) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDir(key === "token" ? "asc" : "desc");
    }
  }

  const sorted = useMemo(() => {
    const copy = [...rows];
    const mul = sortDir === "asc" ? 1 : -1;
    copy.sort((a, b) => {
      switch (sortKey) {
        case "token":
          return mul * a.token.localeCompare(b.token);
        case "lowestPrice":
          return mul * (a.lowestPrice - b.lowestPrice);
        case "highestPrice":
          return mul * (a.highestPrice - b.highestPrice);
        case "spreadUsd":
          return mul * (a.spreadUsd - b.spreadUsd);
        case "spreadPercentage":
        default:
          return mul * (a.spreadPercentage - b.spreadPercentage);
      }
    });
    return copy;
  }, [rows, sortDir, sortKey]);

  const updatedLabel = meta?.updatedAt
    ? new Date(meta.updatedAt).toLocaleString()
    : "—";

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="text-sm text-slate-400">
          <p>
            Top 100 tokens · 10 DEX venues · refreshes every ~4 minutes
            {meta?.fromCache ? " (cached)" : ""}
          </p>
          <p className="text-xs text-slate-500">
            Last updated: {updatedLabel}
            {meta?.source ? ` · Source: ${meta.source}` : ""}
          </p>
        </div>
        <button
          type="button"
          onClick={() => void load(true)}
          disabled={loading || refreshing}
          className="inline-flex items-center justify-center gap-2 rounded-lg border border-slate-700 bg-slate-900 px-4 py-2 text-sm text-slate-200 hover:bg-slate-800 disabled:opacity-50"
        >
          <RefreshCw className={`h-4 w-4 ${refreshing ? "animate-spin" : ""}`} />
          Refresh
        </button>
      </div>

      {error && (
        <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-200">
          {error}
        </div>
      )}

      <div className="overflow-hidden rounded-xl border border-slate-800 bg-slate-900 shadow-lg shadow-black/20">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[960px] text-left text-sm">
            <thead className="border-b border-slate-800 bg-slate-950/60">
              <tr>
                <SortHeader
                  label="Token"
                  sortKey="token"
                  activeKey={sortKey}
                  dir={sortDir}
                  onSort={handleSort}
                />
                <th className="px-4 py-3 text-xs font-medium uppercase tracking-wider text-slate-500">
                  Buy at (lowest)
                </th>
                <th className="px-4 py-3 text-xs font-medium uppercase tracking-wider text-slate-500">
                  Sell at (highest)
                </th>
                <SortHeader
                  label="Spread ($)"
                  sortKey="spreadUsd"
                  activeKey={sortKey}
                  dir={sortDir}
                  onSort={handleSort}
                  align="right"
                />
                <SortHeader
                  label="Spread (%)"
                  sortKey="spreadPercentage"
                  activeKey={sortKey}
                  dir={sortDir}
                  onSort={handleSort}
                  align="right"
                />
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr>
                  <td colSpan={5} className="px-4 py-16 text-center">
                    <Loader2 className="mx-auto h-8 w-8 animate-spin text-cyan-400" />
                  </td>
                </tr>
              ) : sorted.length === 0 ? (
                <tr>
                  <td colSpan={5} className="px-4 py-16 text-center text-slate-500">
                    No spread data available.
                  </td>
                </tr>
              ) : (
                sorted.map((r) => {
                  const spreadHot = r.spreadPercentage > 1;
                  return (
                    <tr
                      key={r.token}
                      className="border-b border-slate-800/80 hover:bg-slate-800/30"
                    >
                      <td className="px-4 py-3">
                        <TokenCell symbol={r.token} name={r.tokenName} />
                      </td>
                      <td className="px-4 py-3">
                        <p className="font-medium tabular-nums text-emerald-400">
                          {fmtUsd(r.lowestPrice)}
                        </p>
                        <p className="text-xs text-slate-500">{r.lowestDex}</p>
                      </td>
                      <td className="px-4 py-3">
                        <p className="font-medium tabular-nums text-amber-300">
                          {fmtUsd(r.highestPrice)}
                        </p>
                        <p className="text-xs text-slate-500">{r.highestDex}</p>
                      </td>
                      <td className="px-4 py-3 text-right tabular-nums text-slate-200">
                        {fmtUsd(r.spreadUsd)}
                      </td>
                      <td
                        className={`px-4 py-3 text-right font-medium tabular-nums ${
                          spreadHot ? "text-emerald-400" : "text-slate-300"
                        }`}
                      >
                        {pctFmt.format(r.spreadPercentage)}%
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>

      {!loading && sorted.length > 0 ? (
        <p className="text-xs text-slate-500">
          Showing {sorted.length} token{sorted.length === 1 ? "" : "s"}. Green spread % indicates
          opportunities above 1%.
        </p>
      ) : null}
    </div>
  );
}
