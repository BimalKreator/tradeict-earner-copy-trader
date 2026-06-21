"use client";

import { Loader2, UserCircle } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import {
  UserProfileForm,
  emptyProfileFormValues,
  profileFormValuesToPayload,
  type ProfileFormValues,
  type UserProfileData,
} from "@/components/profile/UserProfileForm";

const API_BASE = process.env.NEXT_PUBLIC_API_URL;

export default function DashboardProfilePage() {
  const [profile, setProfile] = useState<UserProfileData | null>(null);
  const [values, setValues] = useState<ProfileFormValues>(emptyProfileFormValues());
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<{ type: "ok" | "err"; text: string } | null>(
    null,
  );
  const [unauthorized, setUnauthorized] = useState(false);

  const token =
    typeof window !== "undefined" ? localStorage.getItem("token") : null;

  const load = useCallback(async () => {
    setError(null);
    setToast(null);
    if (!token) {
      setUnauthorized(true);
      setLoading(false);
      setProfile(null);
      return;
    }
    setUnauthorized(false);
    setLoading(true);
    try {
      const res = await fetch(`${API_BASE}/user/profile`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.status === 401) {
        setUnauthorized(true);
        setProfile(null);
        return;
      }
      if (!res.ok) throw new Error(`Failed to load profile (${res.status})`);
      const data = (await res.json()) as { profile?: UserProfileData };
      if (!data.profile) throw new Error("Invalid profile response");
      setProfile(data.profile);
      setValues(emptyProfileFormValues(data.profile));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load profile");
      setProfile(null);
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!toast) return;
    const t = window.setTimeout(() => setToast(null), 5000);
    return () => window.clearTimeout(t);
  }, [toast]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setToast(null);
    if (!token) {
      setUnauthorized(true);
      return;
    }
    setSaving(true);
    try {
      const res = await fetch(`${API_BASE}/user/profile`, {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(profileFormValuesToPayload(values)),
      });
      const body = (await res.json().catch(() => ({}))) as {
        error?: string;
        profile?: UserProfileData;
        message?: string;
      };
      if (!res.ok) {
        throw new Error(body.error ?? `Save failed (${res.status})`);
      }
      if (body.profile) {
        setProfile(body.profile);
        setValues(emptyProfileFormValues(body.profile));
      }
      setToast({
        type: "ok",
        text: body.message ?? "Profile updated successfully.",
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Save failed";
      setError(msg);
      setToast({ type: "err", text: msg });
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
              Manage your personal, identity, and nominee details.
            </p>
            {profile?.name ? (
              <p className="mt-1 text-sm font-medium text-primary">{profile.name}</p>
            ) : null}
          </div>
        </div>
      </header>

      {toast ? (
        <div
          className={`rounded-lg border px-4 py-3 text-sm ${
            toast.type === "ok"
              ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-100"
              : "border-red-500/40 bg-red-500/10 text-red-200"
          }`}
          role="status"
        >
          {toast.text}
        </div>
      ) : null}

      <section className="glass-card border border-glassBorder p-6 md:p-8">
        {loading ? (
          <div className="flex justify-center py-16">
            <Loader2 className="h-10 w-10 animate-spin text-primary" aria-hidden />
          </div>
        ) : profile ? (
          <>
            {error ? (
              <div className="mb-6 rounded-lg border border-red-500/40 bg-red-500/10 px-4 py-3 text-sm text-red-200">
                {error}
              </div>
            ) : null}
            <form id="dashboard-profile-form" onSubmit={(e) => void handleSubmit(e)}>
              <UserProfileForm
                formId="dashboard-profile-form"
                email={profile.email}
                values={values}
                onChange={setValues}
                referrer={profile.referrer}
                upline={profile.upline}
                saving={saving}
              />
            </form>
          </>
        ) : (
          <p className="py-8 text-center text-sm text-white/45">
            {error ?? "Could not load your profile."}
          </p>
        )}
      </section>
    </div>
  );
}
