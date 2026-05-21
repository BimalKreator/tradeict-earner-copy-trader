"use client";

import { Loader2, Plus, RefreshCw, Tag, ToggleLeft, ToggleRight } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

const API_BASE = process.env.NEXT_PUBLIC_API_URL;

type Coupon = {
  id: string;
  code: string;
  discountPercentage: number;
  maxUses: number;
  usedCount: number;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
};

export default function AdminCouponsPage() {
  const [coupons, setCoupons] = useState<Coupon[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [forbidden, setForbidden] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [code, setCode] = useState("");
  const [discountPercentage, setDiscountPercentage] = useState("10");
  const [maxUses, setMaxUses] = useState("100");
  const [bulkCount, setBulkCount] = useState("5");
  const [bulkPrefix, setBulkPrefix] = useState("TICT");

  const token =
    typeof window !== "undefined" ? localStorage.getItem("token") : null;

  const load = useCallback(async () => {
    setError(null);
    if (!token) {
      setForbidden(true);
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const res = await fetch(`${API_BASE}/admin/coupons`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.status === 403) {
        setForbidden(true);
        return;
      }
      if (!res.ok) throw new Error(`Failed (${res.status})`);
      const data = (await res.json()) as { coupons?: Coupon[] };
      setCoupons(data.coupons ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Load failed");
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => {
    void load();
  }, [load]);

  async function createCoupon(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch(`${API_BASE}/admin/coupons`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          code,
          discountPercentage: Number(discountPercentage),
          maxUses: Number(maxUses),
        }),
      });
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(body.error ?? "Create failed");
      setCode("");
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Create failed");
    } finally {
      setSubmitting(false);
    }
  }

  async function createBulk() {
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch(`${API_BASE}/admin/coupons/bulk`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          count: Number(bulkCount),
          prefix: bulkPrefix,
          discountPercentage: Number(discountPercentage),
          maxUses: Number(maxUses),
        }),
      });
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(body.error ?? "Bulk create failed");
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Bulk create failed");
    } finally {
      setSubmitting(false);
    }
  }

  async function toggleActive(id: string) {
    try {
      const res = await fetch(`${API_BASE}/admin/coupons/${id}/toggle`, {
        method: "PATCH",
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) throw new Error("Toggle failed");
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Toggle failed");
    }
  }

  if (forbidden) {
    return (
      <p className="text-sm text-amber-200">Admin access required.</p>
    );
  }

  return (
    <div className="space-y-8">
      <header className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold text-white">Discount coupons</h1>
          <p className="mt-1 text-sm text-white/55">
            Create and manage strategy subscription discount codes.
          </p>
        </div>
        <button
          type="button"
          onClick={() => void load()}
          className="inline-flex items-center gap-2 rounded-lg border border-white/15 bg-white/5 px-3 py-2 text-sm text-white/80"
        >
          <RefreshCw className="h-4 w-4" />
          Refresh
        </button>
      </header>

      {error ? (
        <div className="rounded-lg border border-red-500/40 bg-red-500/10 px-4 py-3 text-sm text-red-200">
          {error}
        </div>
      ) : null}

      <div className="grid gap-6 lg:grid-cols-2">
        <form
          onSubmit={(e) => void createCoupon(e)}
          className="glass-card border border-glassBorder p-6"
        >
          <h2 className="flex items-center gap-2 text-lg font-semibold text-white">
            <Tag className="h-5 w-5 text-primary" />
            Create coupon
          </h2>
          <label className="mt-4 block">
            <span className="text-xs text-white/55">Coupon code</span>
            <input
              value={code}
              onChange={(e) => setCode(e.target.value.toUpperCase())}
              required
              className="mt-1 w-full rounded-lg border border-glassBorder bg-black/40 px-3 py-2 text-sm uppercase text-white"
              placeholder="SAVE20"
            />
          </label>
          <label className="mt-3 block">
            <span className="text-xs text-white/55">Discount %</span>
            <input
              type="number"
              min={1}
              max={100}
              value={discountPercentage}
              onChange={(e) => setDiscountPercentage(e.target.value)}
              required
              className="mt-1 w-full rounded-lg border border-glassBorder bg-black/40 px-3 py-2 text-sm text-white"
            />
          </label>
          <label className="mt-3 block">
            <span className="text-xs text-white/55">Max usage limit</span>
            <input
              type="number"
              min={1}
              value={maxUses}
              onChange={(e) => setMaxUses(e.target.value)}
              required
              className="mt-1 w-full rounded-lg border border-glassBorder bg-black/40 px-3 py-2 text-sm text-white"
            />
          </label>
          <button
            type="submit"
            disabled={submitting}
            className="mt-5 inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2.5 text-sm font-medium text-white disabled:opacity-60"
          >
            {submitting ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Plus className="h-4 w-4" />
            )}
            Create
          </button>
        </form>

        <div className="glass-card border border-glassBorder p-6">
          <h2 className="text-lg font-semibold text-white">Bulk generate</h2>
          <p className="mt-1 text-xs text-white/50">
            Auto-generate unique codes (max 500 per batch).
          </p>
          <label className="mt-4 block">
            <span className="text-xs text-white/55">Count</span>
            <input
              type="number"
              min={1}
              max={500}
              value={bulkCount}
              onChange={(e) => setBulkCount(e.target.value)}
              className="mt-1 w-full rounded-lg border border-glassBorder bg-black/40 px-3 py-2 text-sm text-white"
            />
          </label>
          <label className="mt-3 block">
            <span className="text-xs text-white/55">Code prefix</span>
            <input
              value={bulkPrefix}
              onChange={(e) => setBulkPrefix(e.target.value.toUpperCase())}
              className="mt-1 w-full rounded-lg border border-glassBorder bg-black/40 px-3 py-2 text-sm uppercase text-white"
            />
          </label>
          <p className="mt-3 text-xs text-white/45">
            Uses discount % and max uses from the create form.
          </p>
          <button
            type="button"
            disabled={submitting}
            onClick={() => void createBulk()}
            className="mt-4 rounded-lg border border-white/20 bg-white/10 px-4 py-2.5 text-sm font-medium text-white"
          >
            Generate bulk
          </button>
        </div>
      </div>

      <section className="glass-card overflow-hidden border border-glassBorder">
        <div className="scroll-table overflow-x-auto">
          <table className="w-full min-w-[640px] text-left text-sm">
            <thead>
              <tr className="border-b border-white/10 text-xs uppercase tracking-wider text-white/45">
                <th className="px-4 py-3">Code</th>
                <th className="px-4 py-3">Discount</th>
                <th className="px-4 py-3">Usage</th>
                <th className="px-4 py-3">Status</th>
                <th className="px-4 py-3">Actions</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr>
                  <td colSpan={5} className="px-4 py-12 text-center text-white/50">
                    <Loader2 className="mx-auto h-6 w-6 animate-spin" />
                  </td>
                </tr>
              ) : coupons.length === 0 ? (
                <tr>
                  <td colSpan={5} className="px-4 py-8 text-center text-white/50">
                    No coupons yet.
                  </td>
                </tr>
              ) : (
                coupons.map((c) => (
                  <tr
                    key={c.id}
                    className="border-b border-white/5 text-white/85 hover:bg-white/[0.03]"
                  >
                    <td className="px-4 py-3 font-mono text-xs">{c.code}</td>
                    <td className="px-4 py-3 tabular-nums">{c.discountPercentage}%</td>
                    <td className="px-4 py-3 tabular-nums">
                      {c.usedCount} / {c.maxUses}
                    </td>
                    <td className="px-4 py-3">
                      <span
                        className={`rounded-md px-2 py-0.5 text-xs font-medium ${
                          c.isActive
                            ? "bg-emerald-500/15 text-emerald-200"
                            : "bg-white/10 text-white/50"
                        }`}
                      >
                        {c.isActive ? "Active" : "Inactive"}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <button
                        type="button"
                        onClick={() => void toggleActive(c.id)}
                        className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
                        title="Toggle active"
                      >
                        {c.isActive ? (
                          <ToggleRight className="h-4 w-4" />
                        ) : (
                          <ToggleLeft className="h-4 w-4" />
                        )}
                        Toggle
                      </button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
