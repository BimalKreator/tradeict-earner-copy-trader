"use client";

import { Loader2, UserPlus, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

export type NominatedRole = "MANAGER" | "EXECUTIVE";

export type NominationUplineOption = {
  id: string;
  name: string | null;
  email: string;
  role: string;
  label: string;
};

export type NominationOptions = {
  requesterRole: string;
  allowedRoles: NominatedRole[];
  uplineOptions: NominationUplineOption[];
  defaultUplineId: string;
  uplineLocked: boolean;
};

const NOMINATED_ROLE_LABELS: Record<NominatedRole, string> = {
  EXECUTIVE: "Team Executive",
  MANAGER: "Team Manager",
};

type NominateMemberModalProps = {
  open: boolean;
  apiBase: string;
  token: string | null;
  onClose: () => void;
  onSuccess: (message: string) => void;
  onError: (message: string) => void;
};

export function NominateMemberModal({
  open,
  apiBase,
  token,
  onClose,
  onSuccess,
  onError,
}: NominateMemberModalProps) {
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [options, setOptions] = useState<NominationOptions | null>(null);
  const [email, setEmail] = useState("");
  const [requestedRole, setRequestedRole] = useState<NominatedRole>("EXECUTIVE");
  const [uplineId, setUplineId] = useState("");

  const uplineLocked = useMemo(() => {
    if (!options) return true;
    if (options.uplineLocked) return true;
    if (requestedRole === "MANAGER") return true;
    return false;
  }, [options, requestedRole]);

  const uplineSelectOptions = useMemo(() => {
    if (!options) return [];
    if (requestedRole === "MANAGER") {
      return options.uplineOptions.filter((o) => o.id === options.defaultUplineId);
    }
    return options.uplineOptions;
  }, [options, requestedRole]);

  useEffect(() => {
    if (!open) return;

    setFormError(null);
    setEmail("");
    setOptions(null);
    setLoading(true);

    if (!token) {
      setFormError("Not signed in");
      setLoading(false);
      return;
    }

    void (async () => {
      try {
        const res = await fetch(`${apiBase}/user/partner/nomination-options`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        const body: unknown = await res.json().catch(() => ({}));
        if (!res.ok) {
          const msg =
            typeof body === "object" &&
            body !== null &&
            "error" in body &&
            typeof (body as { error?: unknown }).error === "string"
              ? (body as { error: string }).error
              : `Failed to load nomination options (${res.status})`;
          throw new Error(msg);
        }
        const loaded = body as NominationOptions;
        setOptions(loaded);
        setRequestedRole(loaded.allowedRoles[0] ?? "EXECUTIVE");
        setUplineId(loaded.defaultUplineId);
      } catch (e) {
        setFormError(
          e instanceof Error ? e.message : "Could not load nomination form",
        );
      } finally {
        setLoading(false);
      }
    })();
  }, [open, apiBase, token]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!token || !options) return;

    const targetUserEmail = email.trim();
    if (!targetUserEmail) {
      setFormError("Enter the target user's email address.");
      return;
    }

    const assignedParentId = uplineLocked
      ? options.defaultUplineId
      : uplineId || options.defaultUplineId;

    setSubmitting(true);
    setFormError(null);
    try {
      const res = await fetch(`${apiBase}/user/partner/nominate-member`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          targetUserEmail,
          requestedRole,
          assignedParentId,
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
            : `Nomination failed (${res.status})`;
        throw new Error(msg);
      }
      onSuccess(
        "Nomination submitted. An admin will review your request shortly.",
      );
      onClose();
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Nomination failed";
      setFormError(msg);
      onError(msg);
    } finally {
      setSubmitting(false);
    }
  }

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-labelledby="nominate-member-title"
    >
      <div className="glass-card max-h-[90vh] w-full max-w-lg overflow-y-auto border border-glassBorder p-6 shadow-2xl">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2
              id="nominate-member-title"
              className="text-lg font-semibold text-white"
            >
              Nominate team member
            </h2>
            <p className="mt-1 text-sm text-white/50">
              Submit a user for admin approval. They must have an active strategy
              subscription before upgrade.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border border-white/10 p-2 text-white/60 hover:bg-white/10 hover:text-white"
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {loading ? (
          <div className="flex justify-center py-16">
            <Loader2 className="h-8 w-8 animate-spin text-primary" aria-hidden />
          </div>
        ) : options ? (
          <form onSubmit={(e) => void handleSubmit(e)} className="mt-6 space-y-4">
            {formError ? (
              <p className="rounded-md border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-200">
                {formError}
              </p>
            ) : null}

            <label className="block">
              <span className="text-xs font-medium text-white/60">
                Target user email
              </span>
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="mt-1 w-full rounded-lg border border-glassBorder bg-black/40 px-3 py-2.5 text-sm text-white outline-none ring-primary/30 placeholder:text-white/30 focus:ring-2"
                placeholder="trader@example.com"
                autoComplete="off"
                required
              />
            </label>

            <label className="block">
              <span className="text-xs font-medium text-white/60">
                Requested role
              </span>
              <select
                value={requestedRole}
                onChange={(e) => {
                  const role = e.target.value as NominatedRole;
                  setRequestedRole(role);
                  if (role === "MANAGER" && options) {
                    setUplineId(options.defaultUplineId);
                  }
                }}
                className="mt-1 w-full rounded-lg border border-glassBorder bg-black/40 px-3 py-2.5 text-sm text-white outline-none focus:ring-2 focus:ring-primary/40"
              >
                {options.allowedRoles.map((role) => (
                  <option key={role} value={role}>
                    {NOMINATED_ROLE_LABELS[role]}
                  </option>
                ))}
              </select>
            </label>

            <label className="block">
              <span className="text-xs font-medium text-white/60">
                Assign upline
                {uplineLocked ? " — locked" : ""}
              </span>
              <select
                value={uplineLocked ? options.defaultUplineId : uplineId}
                onChange={(e) => setUplineId(e.target.value)}
                disabled={uplineLocked}
                className="mt-1 w-full rounded-lg border border-glassBorder bg-black/40 px-3 py-2.5 text-sm text-white outline-none focus:ring-2 focus:ring-primary/40 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {uplineSelectOptions.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.label}
                  </option>
                ))}
              </select>
              {requestedRole === "EXECUTIVE" &&
              options.requesterRole === "DIRECTOR" &&
              !uplineLocked ? (
                <p className="mt-1.5 text-xs text-white/40">
                  Choose yourself or one of your Managers as the Executive&apos;s
                  upline.
                </p>
              ) : null}
            </label>

            <div className="flex justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={onClose}
                className="rounded-lg border border-white/15 px-4 py-2 text-sm text-white/75 hover:bg-white/10"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={submitting}
                className="inline-flex items-center gap-2 rounded-lg bg-primary px-5 py-2 text-sm font-medium text-white disabled:opacity-50"
              >
                {submitting ? (
                  <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
                ) : (
                  <UserPlus className="h-4 w-4" aria-hidden />
                )}
                Submit nomination
              </button>
            </div>
          </form>
        ) : (
          <p className="mt-6 text-sm text-red-200">
            {formError ?? "Could not load nomination form."}
          </p>
        )}
      </div>
    </div>
  );
}

type NominateTeamMemberButtonProps = {
  onClick: () => void;
  variant?: "primary" | "secondary";
  className?: string;
};

export function NominateTeamMemberButton({
  onClick,
  variant = "primary",
  className = "",
}: NominateTeamMemberButtonProps) {
  const base =
    variant === "primary"
      ? "bg-primary text-white shadow-lg shadow-primary/25 hover:bg-primary/90"
      : "border border-violet-500/35 bg-violet-500/10 text-violet-100 hover:bg-violet-500/20";

  return (
    <button
      type="button"
      onClick={onClick}
      className={`inline-flex items-center justify-center gap-2 rounded-xl px-4 py-2.5 text-sm font-semibold transition ${base} ${className}`}
    >
      <UserPlus className="h-4 w-4" aria-hidden />
      Nominate Team Member
    </button>
  );
}

export function canNominateTeamMember(role: string | null | undefined): boolean {
  return role === "DIRECTOR" || role === "MANAGER";
}
