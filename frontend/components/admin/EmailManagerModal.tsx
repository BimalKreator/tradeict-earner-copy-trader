"use client";

import { Loader2, Mail, MessageSquare, X } from "lucide-react";
import { useEffect, useState } from "react";

export type EmailManagerRecipient = {
  id: string;
  email: string;
  name: string | null;
};

type EmailManagerModalProps = {
  open: boolean;
  recipient: EmailManagerRecipient | null;
  apiBase: string;
  authHeaders: () => HeadersInit;
  onClose: () => void;
  onToast?: (toast: { type: "ok" | "err"; text: string }) => void;
};

export function EmailManagerModal({
  open,
  recipient,
  apiBase,
  authHeaders,
  onClose,
  onToast,
}: EmailManagerModalProps) {
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [useHtml, setUseHtml] = useState(false);
  const [resending, setResending] = useState(false);
  const [sendingCustom, setSendingCustom] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setSubject("");
    setBody("");
    setUseHtml(false);
    setFormError(null);
    setResending(false);
    setSendingCustom(false);
  }, [open, recipient?.id]);

  if (!open || !recipient) return null;

  const displayName = recipient.name?.trim() || recipient.email;
  const busy = resending || sendingCustom;

  async function handleResendWelcome() {
    setResending(true);
    setFormError(null);
    try {
      const res = await fetch(`${apiBase}/admin/resend-registration-email`, {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({
          userId: recipient!.id,
          templateName: "welcome",
        }),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        throw new Error(data.error ?? "Failed to send welcome email");
      }
      onToast?.({
        type: "ok",
        text: `Welcome email sent to ${recipient!.email}.`,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Email send failed";
      setFormError(msg);
      onToast?.({ type: "err", text: msg });
    } finally {
      setResending(false);
    }
  }

  async function handleSendCustom(e: React.FormEvent) {
    e.preventDefault();
    if (!subject.trim()) {
      setFormError("Subject is required.");
      return;
    }
    if (!body.trim()) {
      setFormError(
        useHtml ? "HTML content is required." : "Message body is required.",
      );
      return;
    }

    setSendingCustom(true);
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
      onToast?.({
        type: "ok",
        text: `Custom email sent to ${recipient!.email}.`,
      });
      onClose();
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to send email";
      setFormError(msg);
      onToast?.({ type: "err", text: msg });
    } finally {
      setSendingCustom(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-labelledby="email-manager-modal-title"
    >
      <div className="glass-card max-h-[90vh] w-full max-w-lg overflow-y-auto border border-glassBorder p-6 shadow-2xl">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2
              id="email-manager-modal-title"
              className="text-lg font-semibold text-white"
            >
              Email Actions for {displayName}
            </h2>
            <p className="mt-1 text-sm text-white/50">{recipient.email}</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="rounded-lg border border-white/10 p-2 text-white/60 hover:bg-white/10 hover:text-white disabled:opacity-50"
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {formError ? (
          <p className="mt-4 rounded-md border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-200">
            {formError}
          </p>
        ) : null}

        <div className="mt-6">
          <button
            type="button"
            disabled={busy}
            onClick={() => void handleResendWelcome()}
            className="inline-flex w-full items-center justify-center gap-2 rounded-lg border border-emerald-500/35 bg-emerald-500/10 px-4 py-2.5 text-sm font-medium text-emerald-100 transition hover:bg-emerald-500/20 disabled:opacity-50"
          >
            {resending ? (
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
            ) : (
              <MessageSquare className="h-4 w-4" aria-hidden />
            )}
            Quick Send: Welcome Email
          </button>
        </div>

        <hr className="my-4 border-gray-700" />

        <form onSubmit={(e) => void handleSendCustom(e)} className="space-y-4">
          <h3 className="text-sm font-medium text-white/80">Send Custom Email</h3>

          <label className="block">
            <span className="text-xs font-medium text-white/60">Subject</span>
            <input
              type="text"
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              maxLength={200}
              disabled={busy}
              className="mt-1 w-full rounded-lg border border-glassBorder bg-black/40 px-3 py-2 text-sm text-white outline-none ring-primary/30 placeholder:text-white/30 focus:ring-2 disabled:opacity-60"
              placeholder="Email subject"
            />
          </label>

          <div className="flex items-center justify-between gap-2">
            <span className="text-xs font-medium text-white/60">
              {useHtml ? "HTML content" : "Message"}
            </span>
            <label className="inline-flex cursor-pointer items-center gap-2 text-xs text-white/50">
              <input
                type="checkbox"
                checked={useHtml}
                onChange={(e) => setUseHtml(e.target.checked)}
                disabled={busy}
                className="rounded border-glassBorder"
              />
              Send as HTML
            </label>
          </div>

          <textarea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            rows={useHtml ? 8 : 6}
            maxLength={50000}
            disabled={busy}
            className="w-full resize-y rounded-lg border border-glassBorder bg-black/40 px-3 py-2 font-mono text-sm text-white outline-none ring-primary/30 placeholder:text-white/30 focus:ring-2 disabled:opacity-60"
            placeholder={
              useHtml
                ? "<p>Hello,</p><p>Your custom HTML message…</p>"
                : "Write your message to the user…"
            }
          />

          <button
            type="submit"
            disabled={busy}
            className="inline-flex w-full items-center justify-center gap-2 rounded-lg bg-primary px-4 py-2.5 text-sm font-medium text-white shadow-lg shadow-primary/20 disabled:opacity-50"
          >
            {sendingCustom ? (
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
            ) : (
              <Mail className="h-4 w-4" aria-hidden />
            )}
            Send Custom Email
          </button>
        </form>

        <div className="mt-6 flex justify-end border-t border-gray-700 pt-4">
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="rounded-lg px-4 py-2 text-sm font-medium text-white/70 transition hover:bg-white/10 disabled:opacity-50"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
