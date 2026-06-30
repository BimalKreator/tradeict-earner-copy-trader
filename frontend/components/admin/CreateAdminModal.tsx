"use client";

import { Loader2, X } from "lucide-react";
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import type { PlatformAdminRole } from "@/context/AdminSessionContext";

const ADMIN_ROLES: PlatformAdminRole[] = ["SUPER_ADMIN", "MANAGER", "SUPPORT"];

type CreateAdminModalProps = {
  open: boolean;
  apiBase: string;
  token: string | null;
  onClose: () => void;
  onSuccess: () => void;
  onError: (message: string) => void;
};

export function CreateAdminModal({
  open,
  apiBase,
  token,
  onClose,
  onSuccess,
  onError,
}: CreateAdminModalProps) {
  const [mounted, setMounted] = useState(false);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [adminRole, setAdminRole] = useState<PlatformAdminRole>("MANAGER");
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  useEffect(() => {
    if (!open) return;
    setEmail("");
    setPassword("");
    setName("");
    setAdminRole("MANAGER");
    setFormError(null);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [open]);

  if (!open || !mounted) return null;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!token) {
      setFormError("Not signed in");
      return;
    }

    setFormError(null);
    setSubmitting(true);
    try {
      const res = await fetch(`${apiBase}/admin/managers`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          email: email.trim(),
          password,
          name: name.trim() || undefined,
          adminRole,
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
            : `Could not create admin (${res.status})`;
        throw new Error(msg);
      }
      onSuccess();
      onClose();
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to create admin";
      setFormError(msg);
      onError(msg);
    } finally {
      setSubmitting(false);
    }
  }

  return createPortal(
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="create-admin-title"
    >
      <button
        type="button"
        className="absolute inset-0 bg-black/70 backdrop-blur-sm"
        aria-label="Close"
        onClick={() => {
          if (!submitting) onClose();
        }}
      />
      <div className="relative z-10 w-full max-w-md rounded-xl border border-glassBorder bg-background/95 p-6 shadow-2xl backdrop-blur">
        <div className="flex items-start justify-between gap-3">
          <h2 id="create-admin-title" className="text-lg font-semibold text-white">
            Create admin
          </h2>
          <button
            type="button"
            onClick={onClose}
            disabled={submitting}
            className="rounded-lg p-1.5 text-white/50 hover:bg-white/10 hover:text-white disabled:opacity-50"
            aria-label="Close"
          >
            <X className="h-5 w-5" aria-hidden />
          </button>
        </div>

        <form onSubmit={(e) => void handleSubmit(e)} className="mt-5 space-y-4">
          <div>
            <label
              htmlFor="admin-email"
              className="block text-xs font-medium uppercase tracking-wider text-white/45"
            >
              Email
            </label>
            <input
              id="admin-email"
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              disabled={submitting}
              className="mt-2 w-full rounded-lg border border-glassBorder bg-white/[0.04] px-3 py-2.5 text-sm text-white focus:border-primary/50 focus:outline-none"
            />
          </div>

          <div>
            <label
              htmlFor="admin-password"
              className="block text-xs font-medium uppercase tracking-wider text-white/45"
            >
              Password
            </label>
            <input
              id="admin-password"
              type="password"
              required
              minLength={8}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              disabled={submitting}
              className="mt-2 w-full rounded-lg border border-glassBorder bg-white/[0.04] px-3 py-2.5 text-sm text-white focus:border-primary/50 focus:outline-none"
            />
          </div>

          <div>
            <label
              htmlFor="admin-name"
              className="block text-xs font-medium uppercase tracking-wider text-white/45"
            >
              Name (optional)
            </label>
            <input
              id="admin-name"
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              disabled={submitting}
              className="mt-2 w-full rounded-lg border border-glassBorder bg-white/[0.04] px-3 py-2.5 text-sm text-white focus:border-primary/50 focus:outline-none"
            />
          </div>

          <div>
            <label
              htmlFor="admin-role"
              className="block text-xs font-medium uppercase tracking-wider text-white/45"
            >
              Role
            </label>
            <select
              id="admin-role"
              value={adminRole}
              onChange={(e) => setAdminRole(e.target.value as PlatformAdminRole)}
              disabled={submitting}
              className="mt-2 w-full rounded-lg border border-glassBorder bg-white/[0.04] px-3 py-2.5 text-sm text-white focus:border-primary/50 focus:outline-none"
            >
              {ADMIN_ROLES.map((role) => (
                <option key={role} value={role} className="bg-slate-900">
                  {role.replace(/_/g, " ")}
                </option>
              ))}
            </select>
          </div>

          {formError ? (
            <p className="text-sm text-red-300" role="alert">
              {formError}
            </p>
          ) : null}

          <button
            type="submit"
            disabled={submitting}
            className="flex w-full items-center justify-center gap-2 rounded-lg bg-primary px-4 py-2.5 text-sm font-semibold text-white hover:bg-primary/90 disabled:opacity-50"
          >
            {submitting ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
                Creating…
              </>
            ) : (
              "Create admin"
            )}
          </button>
        </form>
      </div>
    </div>,
    document.body,
  );
}
