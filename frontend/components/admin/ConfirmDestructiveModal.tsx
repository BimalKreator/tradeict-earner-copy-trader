"use client";

import { AlertTriangle, Loader2, X } from "lucide-react";
import { useEffect, useId, useState } from "react";

export type ConfirmDestructiveModalProps = {
  open: boolean;
  title: string;
  /** Clear description of what will happen (counts, customer, reversibility). */
  description: string;
  /** Exact string the admin must type (email or fixed phrase). */
  expectedConfirmation: string;
  /** Optional label above the expected value (e.g. customer email shown for typing). */
  confirmationLabel?: string;
  /** When set, shows the customer email so admin can see what to type (copy-paste allowed). */
  customerEmail?: string | null;
  confirmButtonText?: string;
  busy?: boolean;
  error?: string | null;
  result?: string | null;
  onClose: () => void;
  /** Called with the typed confirmation when the admin confirms. */
  onConfirm: (confirmation: string) => void | Promise<void>;
};

export function ConfirmDestructiveModal({
  open,
  title,
  description,
  expectedConfirmation,
  confirmationLabel,
  customerEmail,
  confirmButtonText = "Confirm",
  busy = false,
  error = null,
  result = null,
  onClose,
  onConfirm,
}: ConfirmDestructiveModalProps) {
  const inputId = useId();
  const [typed, setTyped] = useState("");

  useEffect(() => {
    if (!open) {
      setTyped("");
      return;
    }
    setTyped("");
  }, [open, expectedConfirmation]);

  if (!open) return null;

  const matches = typed.trim() === expectedConfirmation;
  const canSubmit = matches && !busy;

  return (
    <div
      className="fixed inset-0 z-[80] flex items-center justify-center bg-black/70 p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby={`${inputId}-title`}
    >
      <div className="w-full max-w-lg rounded-2xl border border-red-500/35 bg-[#12141c] shadow-2xl shadow-black/50">
        <div className="flex items-start justify-between gap-3 border-b border-white/10 px-5 py-4">
          <div className="flex items-start gap-3">
            <div className="mt-0.5 rounded-lg border border-red-500/40 bg-red-500/10 p-2 text-red-200">
              <AlertTriangle className="h-4 w-4" aria-hidden />
            </div>
            <div>
              <h2
                id={`${inputId}-title`}
                className="text-base font-semibold text-white"
              >
                {title}
              </h2>
              <p className="mt-1 text-sm leading-relaxed text-white/60">
                {description}
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="rounded-lg p-1.5 text-white/50 hover:bg-white/10 hover:text-white disabled:opacity-50"
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="space-y-4 px-5 py-4">
          {customerEmail ? (
            <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-100">
              Customer email (type this exactly):{" "}
              <span className="font-semibold select-all">{customerEmail}</span>
            </div>
          ) : null}

          <div>
            <label
              htmlFor={inputId}
              className="mb-1.5 block text-xs font-medium uppercase tracking-wide text-white/45"
            >
              {confirmationLabel ??
                (customerEmail
                  ? "Type the customer email to confirm"
                  : `Type “${expectedConfirmation}” to confirm`)}
            </label>
            <input
              id={inputId}
              type="text"
              autoComplete="off"
              autoFocus
              disabled={busy}
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && canSubmit) {
                  e.preventDefault();
                  void onConfirm(typed.trim());
                }
              }}
              placeholder={expectedConfirmation}
              className="w-full rounded-xl border border-white/15 bg-black/40 px-3 py-2.5 text-sm text-white placeholder:text-white/30 focus:border-red-400/50 focus:outline-none disabled:opacity-60"
            />
          </div>

          {error ? (
            <p className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-200">
              {error}
            </p>
          ) : null}

          {result ? (
            <p className="rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-100">
              {result}
            </p>
          ) : null}
        </div>

        <div className="flex justify-end gap-2 border-t border-white/10 px-5 py-4">
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="rounded-xl border border-white/15 px-4 py-2 text-sm text-white/70 hover:bg-white/5 disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={!canSubmit}
            onClick={() => void onConfirm(typed.trim())}
            className="inline-flex items-center gap-2 rounded-xl bg-red-600/90 px-4 py-2 text-sm font-semibold text-white hover:bg-red-500 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : null}
            {busy ? "Working…" : confirmButtonText}
          </button>
        </div>
      </div>
    </div>
  );
}
