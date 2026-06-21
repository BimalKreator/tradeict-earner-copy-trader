"use client";

import { Loader2, Mail, X } from "lucide-react";
import { useEffect, useState } from "react";

export type CustomEmailRecipient = {
  id: string;
  email: string;
  name: string | null;
};

type CustomEmailModalProps = {
  open: boolean;
  recipient: CustomEmailRecipient | null;
  apiBase: string;
  authHeaders: () => HeadersInit;
  onClose: () => void;
  onSuccess: (message: string) => void;
  onError: (message: string) => void;
};

export function CustomEmailModal({
  open,
  recipient,
  apiBase,
  authHeaders,
  onClose,
  onSuccess,
  onError,
}: CustomEmailModalProps) {
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [useHtml, setUseHtml] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setSubject("");
    setBody("");
    setUseHtml(false);
    setFormError(null);
    setSubmitting(false);
  }, [open, recipient?.id]);

  if (!open || !recipient) return null;

  const displayName = recipient.name?.trim() || recipient.email;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!subject.trim()) {
      setFormError("Subject is required.");
      return;
    }
    if (!body.trim()) {
      setFormError(useHtml ? "HTML content is required." : "Message body is required.");
      return;
    }

    setSubmitting(true);
    setFormError(null);
    try {
      const payload = useHtml
        ? {
            userId: recipient!.id,
            subject: subject.trim(),
            htmlContent: body.trim(),
          }
        : {
            userId: recipient!.id,
            subject: subject.trim(),
            body: body.trim(),
          };

      const res = await fetch(`${apiBase}/admin/send-custom-email`, {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify(payload),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        throw new Error(data.error ?? "Failed to send email");
      }
      onSuccess(`Custom email sent to ${recipient!.email}.`);
      onClose();
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to send email";
      setFormError(msg);
      onError(msg);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-labelledby="custom-email-modal-title"
    >
      <div className="glass-card max-h-[90vh] w-full max-w-lg overflow-y-auto border border-glassBorder p-6 shadow-2xl">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2
              id="custom-email-modal-title"
              className="text-lg font-semibold text-white"
            >
              Send custom message
            </h2>
            <p className="mt-1 text-sm text-white/50">
              To <strong className="text-white/80">{displayName}</strong> (
              {recipient.email})
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={submitting}
            className="rounded-lg border border-white/10 p-2 text-white/60 hover:bg-white/10 hover:text-white disabled:opacity-50"
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <form onSubmit={(e) => void handleSubmit(e)} className="mt-6 space-y-4">
          {formError ? (
            <p className="rounded-md border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-200">
              {formError}
            </p>
          ) : null}

          <label className="block">
            <span className="text-xs font-medium text-white/60">Subject</span>
            <input
              type="text"
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              maxLength={200}
              disabled={submitting}
              className="mt-1 w-full rounded-lg border border-glassBorder bg-black/40 px-3 py-2 text-sm text-white outline-none ring-primary/30 placeholder:text-white/30 focus:ring-2 disabled:opacity-60"
              placeholder="Email subject"
            />
          </label>

          <div className="flex items-center justify-between gap-2">
            <span className="text-xs font-medium text-white/60">
              {useHtml ? "HTML content" : "Message body"}
            </span>
            <label className="inline-flex cursor-pointer items-center gap-2 text-xs text-white/50">
              <input
                type="checkbox"
                checked={useHtml}
                onChange={(e) => setUseHtml(e.target.checked)}
                disabled={submitting}
                className="rounded border-glassBorder"
              />
              Send as HTML
            </label>
          </div>

          <textarea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            rows={useHtml ? 10 : 8}
            maxLength={50000}
            disabled={submitting}
            className="w-full resize-y rounded-lg border border-glassBorder bg-black/40 px-3 py-2 font-mono text-sm text-white outline-none ring-primary/30 placeholder:text-white/30 focus:ring-2 disabled:opacity-60"
            placeholder={
              useHtml
                ? "<p>Hello,</p><p>Your custom HTML message…</p>"
                : "Write your message to the user…"
            }
          />

          <div className="flex justify-end gap-3 pt-2">
            <button
              type="button"
              onClick={onClose}
              disabled={submitting}
              className="rounded-lg px-4 py-2 text-sm font-medium text-white/70 transition hover:bg-white/10 disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={submitting}
              className="inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white shadow-lg shadow-primary/20 disabled:opacity-50"
            >
              {submitting ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
                  Sending…
                </>
              ) : (
                <>
                  <Mail className="h-4 w-4" aria-hidden />
                  Send email
                </>
              )}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
