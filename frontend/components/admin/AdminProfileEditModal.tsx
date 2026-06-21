"use client";

import { Loader2, X } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import {
  UserProfileForm,
  emptyProfileFormValues,
  profileFormValuesToPayload,
  type ProfileFormValues,
  type UserProfileData,
} from "@/components/profile/UserProfileForm";

type AdminProfileEditModalProps = {
  open: boolean;
  userId: string | null;
  userLabel?: string;
  apiBase: string;
  authHeaders: () => HeadersInit;
  onClose: () => void;
  onToast?: (toast: { type: "ok" | "err"; text: string }) => void;
};

export function AdminProfileEditModal({
  open,
  userId,
  userLabel,
  apiBase,
  authHeaders,
  onClose,
  onToast,
}: AdminProfileEditModalProps) {
  const [mounted, setMounted] = useState(false);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [profile, setProfile] = useState<UserProfileData | null>(null);
  const [values, setValues] = useState<ProfileFormValues>(emptyProfileFormValues());

  useEffect(() => {
    setMounted(true);
  }, []);

  const loadProfile = useCallback(async () => {
    if (!userId) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(
        `${apiBase}/admin/users/${encodeURIComponent(userId)}/profile`,
        { headers: authHeaders() },
      );
      const body = (await res.json().catch(() => ({}))) as {
        error?: string;
        profile?: UserProfileData;
      };
      if (!res.ok) {
        throw new Error(body.error ?? `Failed to load profile (${res.status})`);
      }
      if (!body.profile) throw new Error("Invalid profile response");
      setProfile(body.profile);
      setValues(emptyProfileFormValues(body.profile));
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Could not load profile";
      setError(msg);
      setProfile(null);
    } finally {
      setLoading(false);
    }
  }, [apiBase, authHeaders, userId]);

  useEffect(() => {
    if (!open || !userId) {
      setProfile(null);
      setError(null);
      return;
    }
    void loadProfile();
  }, [open, userId, loadProfile]);

  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [open]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!userId) return;
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(
        `${apiBase}/admin/users/${encodeURIComponent(userId)}/profile`,
        {
          method: "PUT",
          headers: authHeaders(),
          body: JSON.stringify(profileFormValuesToPayload(values)),
        },
      );
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
      onToast?.({
        type: "ok",
        text: body.message ?? "Profile updated successfully.",
      });
      onClose();
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Save failed";
      setError(msg);
      onToast?.({ type: "err", text: msg });
    } finally {
      setSaving(false);
    }
  }

  if (!mounted || !open || !userId) return null;

  const title = userLabel?.trim() || profile?.name?.trim() || profile?.email || "User";

  return createPortal(
    <div
      className="fixed inset-0 z-[200] flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-labelledby="admin-profile-modal-title"
      onClick={(e) => {
        if (e.target === e.currentTarget && !saving) onClose();
      }}
    >
      <div
        className="glass-card flex max-h-[92vh] w-full max-w-3xl flex-col border border-glassBorder shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3 border-b border-glassBorder px-6 py-4">
          <div>
            <h2
              id="admin-profile-modal-title"
              className="text-lg font-semibold text-white"
            >
              Edit profile — {title}
            </h2>
            <p className="mt-1 text-sm text-white/50">
              Update KYC and personal details for this user.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={saving}
            className="rounded-lg border border-white/10 p-2 text-white/60 hover:bg-white/10 hover:text-white disabled:opacity-50"
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-6 py-5">
          {error ? (
            <div className="mb-4 rounded-lg border border-red-500/40 bg-red-500/10 px-4 py-3 text-sm text-red-200">
              {error}
            </div>
          ) : null}

          {loading ? (
            <div className="flex justify-center py-16">
              <Loader2 className="h-8 w-8 animate-spin text-primary" aria-hidden />
            </div>
          ) : profile ? (
            <form id="admin-profile-form" onSubmit={(e) => void handleSubmit(e)}>
              <UserProfileForm
                formId="admin-profile-form"
                email={profile.email}
                values={values}
                onChange={setValues}
                referrer={profile.referrer}
                upline={profile.upline}
                saving={saving}
              />
            </form>
          ) : (
            <p className="py-8 text-center text-sm text-white/45">
              Profile could not be loaded.
            </p>
          )}
        </div>

        <div className="flex justify-end border-t border-glassBorder px-6 py-4">
          <button
            type="button"
            onClick={onClose}
            disabled={saving}
            className="rounded-lg px-4 py-2 text-sm font-medium text-white/70 transition hover:bg-white/10 disabled:opacity-50"
          >
            Close
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

export type { UserProfileData } from "@/components/profile/UserProfileForm";
