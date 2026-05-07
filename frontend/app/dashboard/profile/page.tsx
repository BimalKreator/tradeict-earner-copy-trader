"use client";

import { Loader2, UserCircle } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";

const API_BASE = process.env.NEXT_PUBLIC_API_URL;

type Me = {
  id: string;
  email: string;
  name: string | null;
  mobile: string | null;
  address: string | null;
  panNumber: string | null;
  aadhaarNumber: string | null;
  pendingApprovalFields?: string[];
};

export default function DashboardProfilePage() {
  const [me, setMe] = useState<Me | null>(null);
  const [address, setAddress] = useState("");
  const [panNumber, setPanNumber] = useState("");
  const [aadhaarNumber, setAadhaarNumber] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const [unauthorized, setUnauthorized] = useState(false);

  const token =
    typeof window !== "undefined" ? localStorage.getItem("token") : null;

  const load = useCallback(async () => {
    setError(null);
    setSuccess(false);
    if (!token) {
      setUnauthorized(true);
      setLoading(false);
      setMe(null);
      return;
    }
    setUnauthorized(false);
    setLoading(true);
    try {
      const res = await fetch(`${API_BASE}/user/me`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.status === 401) {
        setUnauthorized(true);
        setMe(null);
        return;
      }
      if (!res.ok) throw new Error(`Failed to load profile (${res.status})`);
      const data: unknown = await res.json();
      if (
        typeof data !== "object" ||
        data === null ||
        typeof (data as Me).email !== "string"
      ) {
        throw new Error("Invalid profile response");
      }
      const row = data as Me;
      setMe(row);
      setAddress(row.address ?? "");
      setPanNumber(row.panNumber ?? "");
      setAadhaarNumber(row.aadhaarNumber ?? "");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load profile");
      setMe(null);
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- on-mount fetch is a legitimate effect side-effect
    void load();
  }, [load]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSuccess(false);
    if (!token) {
      setUnauthorized(true);
      return;
    }
    setSaving(true);
    try {
      const res = await fetch(`${API_BASE}/user/me`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          address: address.trim() || null,
          panNumber: panNumber.trim() || null,
          aadhaarNumber: aadhaarNumber.trim() || null,
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
            : `Save failed (${res.status})`;
        throw new Error(msg);
      }
      const row = body as { user: Me; message?: string };
      setMe(row.user);
      setAddress(row.user.address ?? "");
      setPanNumber(row.user.panNumber ?? "");
      setAadhaarNumber(row.user.aadhaarNumber ?? "");
      setSuccess(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Save failed");
    } finally {
      setSaving(false);
    }
  }

  if (unauthorized) {
    return (
      <div className="rounded-xl border border-amber-500/35 bg-amber-500/10 px-6 py-10 text-center">
        <p className="text-sm text-white/70">Sign in to edit your profile.</p>
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
    <div className="space-y-8">
      <header className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-start gap-3">
          <div className="rounded-xl border border-glassBorder bg-primary/10 p-3">
            <UserCircle className="h-6 w-6 text-primary" aria-hidden />
          </div>
          <div>
            <h1 className="text-2xl font-semibold tracking-tight text-white md:text-3xl">
              Profile
            </h1>
            <p className="mt-1 text-sm text-white/55">
              Manage your profile and KYC details.
            </p>
            {me?.name && (
              <p className="mt-1 text-sm font-medium text-primary">
                {me.name}
              </p>
            )}
          </div>
        </div>
      </header>

      <section className="glass-card border border-glassBorder p-6 md:p-8">
        {loading ? (
          <div className="flex justify-center py-16">
            <Loader2 className="h-10 w-10 animate-spin text-primary" aria-hidden />
          </div>
        ) : (
          <form className="mx-auto max-w-lg space-y-6" onSubmit={handleSubmit}>
            {me && (
              <div className="rounded-lg border border-white/[0.08] bg-black/25 px-4 py-3">
                <p className="text-xs font-medium uppercase tracking-wider text-white/40">
                  Email
                </p>
                <p className="mt-1 text-sm text-white/85">{me.email}</p>
              </div>
            )}
            {me && (
              <div className="rounded-lg border border-white/[0.08] bg-black/25 px-4 py-3">
                <p className="text-xs font-medium uppercase tracking-wider text-white/40">
                  Mobile
                </p>
                <p className="mt-1 text-sm text-white/85">{me.mobile ?? "—"}</p>
              </div>
            )}

            {error && (
              <div className="rounded-lg border border-red-500/40 bg-red-500/10 px-4 py-3 text-sm text-red-200">
                {error}
              </div>
            )}

            {success && (
              <div className="rounded-lg border border-emerald-500/40 bg-emerald-500/10 px-4 py-3 text-sm text-emerald-100">
                Your update request has been submitted to the Admin. Changes will be reflected in your profile once approved.
              </div>
            )}

            <label className="block">
              <span className="text-xs font-medium text-white/60">Address</span>
              {me?.pendingApprovalFields?.includes("address") && (
                <span className="ml-2 rounded-full bg-amber-500/15 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-amber-200">
                  Pending Approval
                </span>
              )}
              <input
                type="text"
                value={address}
                onChange={(e) => setAddress(e.target.value)}
                disabled={Boolean(me?.pendingApprovalFields?.includes("address"))}
                className="mt-2 w-full rounded-lg border border-glassBorder bg-black/40 px-4 py-3 text-sm text-white outline-none ring-primary/25 placeholder:text-white/30 focus:ring-2"
                placeholder="Your address"
              />
            </label>

            <label className="block">
              <span className="text-xs font-medium text-white/60">PAN Card</span>
              {me?.pendingApprovalFields?.includes("panNumber") && (
                <span className="ml-2 rounded-full bg-amber-500/15 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-amber-200">
                  Pending Approval
                </span>
              )}
              <input
                type="text"
                value={panNumber}
                onChange={(e) => setPanNumber(e.target.value)}
                disabled={Boolean(me?.pendingApprovalFields?.includes("panNumber"))}
                className="mt-2 w-full rounded-lg border border-glassBorder bg-black/40 px-4 py-3 text-sm text-white outline-none ring-primary/25 placeholder:text-white/30 focus:ring-2"
                placeholder="ABCDE1234F"
              />
            </label>

            <label className="block">
              <span className="text-xs font-medium text-white/60">Aadhaar Number</span>
              {me?.pendingApprovalFields?.includes("aadhaarNumber") && (
                <span className="ml-2 rounded-full bg-amber-500/15 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-amber-200">
                  Pending Approval
                </span>
              )}
              <input
                type="text"
                value={aadhaarNumber}
                onChange={(e) => setAadhaarNumber(e.target.value)}
                disabled={Boolean(me?.pendingApprovalFields?.includes("aadhaarNumber"))}
                className="mt-2 w-full rounded-lg border border-glassBorder bg-black/40 px-4 py-3 text-sm text-white outline-none ring-primary/25 placeholder:text-white/30 focus:ring-2"
                placeholder="1234 5678 9012"
              />
            </label>

            <div className="flex justify-end pt-2">
              <button
                type="submit"
                disabled={saving}
                className="rounded-lg bg-primary px-6 py-2.5 text-sm font-medium text-white shadow-lg shadow-primary/20 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {saving ? "Saving…" : "Save changes"}
              </button>
            </div>
          </form>
        )}
      </section>
    </div>
  );
}
