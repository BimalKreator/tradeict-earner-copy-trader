"use client";

import {
  ChevronDown,
  ChevronRight,
  GitBranch,
  Loader2,
  RefreshCw,
  UserRound,
  Users,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

const ENV_API_BASE =
  process.env.NEXT_PUBLIC_API_URL?.trim().replace(/\/$/, "") ?? "";

function resolveApiBase(): string {
  if (ENV_API_BASE) return ENV_API_BASE;
  if (typeof window !== "undefined") {
    return `${window.location.origin.replace(/\/$/, "")}/api`;
  }
  return "";
}

function authHeaders(): HeadersInit {
  const token =
    typeof window !== "undefined" ? localStorage.getItem("token") : null;
  return token ? { Authorization: `Bearer ${token}` } : {};
}

type NetworkNode = {
  id: string;
  name: string | null;
  email: string;
  role: string;
  nodeType: "member" | "acquired";
  parentId: string | null;
  acquiredById: string | null;
  directAcquiredCount: number;
  networkAum: number;
  affiliateStatus: "ACTIVE" | "SUSPENDED" | null;
  children: NetworkNode[];
};

type NetworkNodeFlat = Omit<NetworkNode, "children">;

type NetworkPayload = {
  tree: NetworkNode[];
  flat?: NetworkNodeFlat[];
  stats: {
    totalMembers: number;
    totalAcquired: number;
    totalNetworkAum: number;
  };
};

const usdFmt = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 0,
  maximumFractionDigits: 0,
});

function fmtUsd(n: number): string {
  return usdFmt.format(Math.max(0, n));
}

function roleBadgeClass(role: string): string {
  if (role === "DIRECTOR") return "bg-violet-500/15 text-violet-200 ring-violet-500/30";
  if (role === "MANAGER") return "bg-sky-500/15 text-sky-200 ring-sky-500/30";
  if (role === "EXECUTIVE") return "bg-emerald-500/15 text-emerald-200 ring-emerald-500/30";
  return "bg-white/10 text-white/70 ring-white/20";
}

function roleLabel(role: string, nodeType: NetworkNode["nodeType"]): string {
  if (nodeType === "acquired") return "Acquired User";
  if (role === "DIRECTOR") return "Director";
  if (role === "MANAGER") return "Manager";
  if (role === "EXECUTIVE") return "Executive";
  return role;
}

/** Rebuild tree from flat list when API tree is empty but members exist. */
function buildTreeFromFlat(flat: NetworkNodeFlat[]): NetworkNode[] {
  const members = flat.filter((n) => n.nodeType === "member");
  const acquired = flat.filter((n) => n.nodeType === "acquired");
  const map = new Map<string, NetworkNode>();

  for (const m of members) {
    map.set(m.id, { ...m, children: [] });
  }

  const attached = new Set<string>();
  for (const m of members) {
    const node = map.get(m.id)!;
    if (m.parentId && m.parentId !== m.id && map.has(m.parentId)) {
      map.get(m.parentId)!.children.push(node);
      attached.add(m.id);
    }
  }

  const roots: NetworkNode[] = [];
  for (const m of members) {
    if (!attached.has(m.id)) {
      roots.push(map.get(m.id)!);
    }
  }

  if (roots.length === 0 && members.length > 0) {
    roots.push(...map.values());
  }

  for (const a of acquired) {
    if (a.acquiredById && map.has(a.acquiredById)) {
      map.get(a.acquiredById)!.children.push({ ...a, children: [] });
    }
  }

  return roots;
}

function normalizePayload(raw: NetworkPayload): NetworkPayload {
  let tree = Array.isArray(raw.tree) ? raw.tree : [];
  const flat = Array.isArray(raw.flat) ? raw.flat : [];

  if (tree.length === 0 && flat.length > 0) {
    tree = buildTreeFromFlat(flat);
  }

  if (process.env.NODE_ENV !== "production") {
    console.log("[network-tree] payload", {
      treeRoots: tree.length,
      flatRows: flat.length,
      stats: raw.stats,
      tree,
    });
  }

  return { ...raw, tree, flat };
}

function NetworkTreeNodeRow({
  node,
  depth,
  defaultExpanded,
}: {
  node: NetworkNode;
  depth: number;
  defaultExpanded: boolean;
}) {
  const hasChildren = node.children.length > 0;
  const [expanded, setExpanded] = useState(defaultExpanded);
  const indent = depth * 20;

  return (
    <li className="list-none">
      <div
        className="group flex flex-col gap-2 border-b border-glassBorder/60 px-4 py-3 transition hover:bg-white/[0.03] sm:flex-row sm:items-center sm:justify-between sm:px-5"
        style={{ paddingLeft: `${16 + indent}px` }}
      >
        <div className="flex min-w-0 flex-1 items-start gap-2 sm:items-center">
          {hasChildren ? (
            <button
              type="button"
              onClick={() => setExpanded((v) => !v)}
              className="mt-0.5 shrink-0 rounded-md p-1 text-white/45 transition hover:bg-white/10 hover:text-white sm:mt-0"
              aria-expanded={expanded}
              aria-label={expanded ? "Collapse" : "Expand"}
            >
              {expanded ? (
                <ChevronDown className="h-4 w-4" aria-hidden />
              ) : (
                <ChevronRight className="h-4 w-4" aria-hidden />
              )}
            </button>
          ) : (
            <span className="inline-block w-6 shrink-0" aria-hidden />
          )}

          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              {node.nodeType === "member" ? (
                <UserRound className="h-4 w-4 shrink-0 text-primary/70" aria-hidden />
              ) : (
                <Users className="h-4 w-4 shrink-0 text-white/35" aria-hidden />
              )}
              <p className="truncate font-medium text-white">
                {node.name?.trim() || node.email}
              </p>
              <span
                className={`inline-flex rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ring-1 ${roleBadgeClass(node.role)}`}
              >
                {roleLabel(node.role, node.nodeType)}
              </span>
              {node.affiliateStatus === "SUSPENDED" ? (
                <span className="inline-flex rounded-full bg-amber-500/15 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-amber-200 ring-1 ring-amber-500/30">
                  Suspended
                </span>
              ) : null}
            </div>
            {node.name?.trim() ? (
              <p className="mt-0.5 truncate text-xs text-white/40">{node.email}</p>
            ) : null}
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-4 pl-8 text-xs sm:pl-0 sm:text-sm">
          {node.nodeType === "member" ? (
            <div className="text-white/45">
              <span className="text-white/30">Direct:</span>{" "}
              <span className="font-medium tabular-nums text-white/75">
                {node.directAcquiredCount}
              </span>
            </div>
          ) : null}
          <div className="text-white/45">
            <span className="text-white/30">
              {node.nodeType === "member" ? "Network AUM:" : "Balance:"}
            </span>{" "}
            <span className="font-semibold tabular-nums text-emerald-200/90">
              {fmtUsd(node.networkAum)}
            </span>
          </div>
        </div>
      </div>

      {hasChildren && expanded ? (
        <ul>
          {node.children.map((child) => (
            <NetworkTreeNodeRow
              key={child.id}
              node={child}
              depth={depth + 1}
              defaultExpanded={depth < 1}
            />
          ))}
        </ul>
      ) : null}
    </li>
  );
}

export default function AdminNetworkPage() {
  const apiBase = useMemo(() => resolveApiBase(), []);

  const [data, setData] = useState<NetworkPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loadSucceeded, setLoadSucceeded] = useState(false);

  const load = useCallback(async () => {
    const token =
      typeof window !== "undefined" ? localStorage.getItem("token") : null;
    if (!token) throw new Error("Not signed in");

    const res = await fetch(`${apiBase}/admin/network-tree`, {
      headers: authHeaders(),
    });
    if (!res.ok) {
      const body: unknown = await res.json().catch(() => ({}));
      const msg =
        typeof body === "object" &&
        body !== null &&
        "error" in body &&
        typeof (body as { error?: unknown }).error === "string"
          ? (body as { error: string }).error
          : `Failed to load network (${res.status})`;
      throw new Error(msg);
    }

    const payload = normalizePayload((await res.json()) as NetworkPayload);
    setData(payload);
    setLoadSucceeded(true);
  }, [apiBase]);

  useEffect(() => {
    void (async () => {
      try {
        await load();
      } catch (e) {
        setError(e instanceof Error ? e.message : "Failed to load network tree");
        setLoadSucceeded(false);
      } finally {
        setLoading(false);
      }
    })();
  }, [load]);

  async function handleRefresh() {
    setRefreshing(true);
    setError(null);
    try {
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Refresh failed");
      setLoadSucceeded(false);
    } finally {
      setRefreshing(false);
    }
  }

  const treeEmpty = !data || data.tree.length === 0;

  return (
    <div className="w-full min-w-0 space-y-6">
      <header className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex items-start gap-4">
          <div className="rounded-xl border border-violet-500/30 bg-violet-500/10 p-3">
            <GitBranch className="h-7 w-7 text-violet-300" aria-hidden />
          </div>
          <div>
            <h1 className="text-2xl font-semibold tracking-tight text-white md:text-3xl">
              Network Tree
            </h1>
            <p className="mt-1 text-sm text-white/50">
              Sales hierarchy and acquired traders — Directors → Managers →
              Executives → Users
            </p>
          </div>
        </div>
        <button
          type="button"
          onClick={() => void handleRefresh()}
          disabled={loading || refreshing}
          className="inline-flex items-center gap-2 self-start rounded-xl border border-glassBorder bg-white/[0.04] px-4 py-2.5 text-sm font-medium text-white/80 transition hover:bg-white/[0.08] disabled:opacity-50"
        >
          <RefreshCw
            className={`h-4 w-4 ${refreshing ? "animate-spin" : ""}`}
            aria-hidden
          />
          Refresh
        </button>
      </header>

      {error ? (
        <div className="rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-200">
          {error}
        </div>
      ) : null}

      {data ? (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <div className="glass-card border border-glassBorder p-5">
            <p className="text-xs font-medium uppercase tracking-wider text-white/45">
              Team members
            </p>
            <p className="mt-2 text-3xl font-semibold tabular-nums text-white">
              {data.stats.totalMembers}
            </p>
          </div>
          <div className="glass-card border border-glassBorder p-5">
            <p className="text-xs font-medium uppercase tracking-wider text-white/45">
              Acquired users
            </p>
            <p className="mt-2 text-3xl font-semibold tabular-nums text-white">
              {data.stats.totalAcquired}
            </p>
          </div>
          <div className="glass-card border border-glassBorder p-5">
            <p className="text-xs font-medium uppercase tracking-wider text-white/45">
              Total network AUM
            </p>
            <p className="mt-2 text-3xl font-semibold tabular-nums text-emerald-200">
              {fmtUsd(data.stats.totalNetworkAum)}
            </p>
          </div>
        </div>
      ) : null}

      <div className="glass-card overflow-hidden border border-glassBorder">
        <div className="border-b border-glassBorder bg-white/[0.03] px-5 py-4">
          <h2 className="text-sm font-semibold uppercase tracking-wider text-white/50">
            Hierarchy
          </h2>
        </div>

        {loading ? (
          <div className="flex justify-center py-20">
            <Loader2 className="h-8 w-8 animate-spin text-primary" aria-label="Loading" />
          </div>
        ) : treeEmpty ? (
          <div className="px-6 py-16 text-center text-sm text-white/45">
            {loadSucceeded
              ? "No network data available. Please assign hierarchy."
              : "No partner network nodes yet. Upgrade users to team members to build the tree."}
          </div>
        ) : (
          <ul className="divide-y divide-glassBorder/40">
            {data.tree.map((root) => (
              <NetworkTreeNodeRow
                key={root.id}
                node={root}
                depth={0}
                defaultExpanded
              />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
