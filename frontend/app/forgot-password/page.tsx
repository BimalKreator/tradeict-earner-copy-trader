"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState, type FormEvent } from "react";

const AUTH_API = process.env.NEXT_PUBLIC_API_URL;

type Step = "email" | "otp" | "password";

async function parseApiError(res: Response): Promise<string> {
  const body: unknown = await res.json().catch(() => ({}));
  if (
    typeof body === "object" &&
    body !== null &&
    "error" in body &&
    typeof (body as { error?: unknown }).error === "string"
  ) {
    return (body as { error: string }).error;
  }
  return `Request failed (${res.status})`;
}

export default function ForgotPasswordPage() {
  const router = useRouter();
  const [step, setStep] = useState<Step>("email");
  const [email, setEmail] = useState("");
  const [otp, setOtp] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  useEffect(() => {
    if (!toast) return;
    const t = window.setTimeout(() => setToast(null), 4000);
    return () => window.clearTimeout(t);
  }, [toast]);

  async function handleEmailSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const res = await fetch(`${AUTH_API}/auth/forgot-password`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: email.trim().toLowerCase() }),
      });
      if (!res.ok) {
        throw new Error(await parseApiError(res));
      }
      setOtp("");
      setStep("otp");
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Could not send reset code",
      );
    } finally {
      setLoading(false);
    }
  }

  function handleOtpSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (otp.trim().length !== 6) {
      setError("Enter the 6-digit code from your email.");
      return;
    }
    setError(null);
    setStep("password");
  }

  async function handlePasswordSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    if (newPassword.length < 8) {
      setError("Password must be at least 8 characters.");
      return;
    }
    if (newPassword !== confirmPassword) {
      setError("Passwords do not match.");
      return;
    }
    setLoading(true);
    try {
      const res = await fetch(`${AUTH_API}/auth/reset-password`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: email.trim().toLowerCase(),
          otp: otp.trim(),
          newPassword,
        }),
      });
      if (!res.ok) {
        throw new Error(await parseApiError(res));
      }
      setToast("Password reset successful");
      window.setTimeout(() => {
        router.push("/login");
      }, 1200);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not reset password");
    } finally {
      setLoading(false);
    }
  }

  const stepTitle =
    step === "email"
      ? "Reset password"
      : step === "otp"
        ? "Enter verification code"
        : "Choose a new password";

  const stepSubtitle =
    step === "email"
      ? "Enter your account email and we’ll send you a 6-digit code."
      : step === "otp"
        ? `Check ${email.trim().toLowerCase()} for your reset code.`
        : "Create a new password for your account.";

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4 py-12">
      <div className="glass-card relative w-full max-w-md border border-glassBorder p-8 shadow-2xl">
        {toast && (
          <div className="absolute left-4 right-4 top-4 z-10 rounded-lg border border-emerald-500/40 bg-emerald-500/15 px-4 py-3 text-sm text-emerald-100 shadow-lg">
            {toast}
          </div>
        )}

        <div className="mb-8 text-center">
          <p className="text-xs font-medium uppercase tracking-widest text-primary">
            TradeICT Earner
          </p>
          <h1 className="mt-2 text-2xl font-semibold text-white">{stepTitle}</h1>
          <p className="mt-2 text-sm text-white/55">{stepSubtitle}</p>
          <p className="mt-3 text-xs text-white/40">
            Step {step === "email" ? 1 : step === "otp" ? 2 : 3} of 3
          </p>
        </div>

        {error && (
          <div className="mb-6 rounded-lg border border-red-500/40 bg-red-500/10 px-4 py-3 text-sm text-red-200">
            {error}
          </div>
        )}

        {step === "email" && (
          <form onSubmit={handleEmailSubmit} className="space-y-5">
            <label className="block">
              <span className="text-xs font-medium text-white/60">Email</span>
              <input
                type="email"
                autoComplete="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                disabled={loading}
                className="mt-2 w-full rounded-lg border border-glassBorder bg-black/40 px-4 py-3 text-sm text-white outline-none ring-primary/30 placeholder:text-white/35 focus:ring-2 disabled:opacity-50"
                placeholder="you@example.com"
              />
            </label>
            <button
              type="submit"
              disabled={loading}
              className="w-full rounded-lg bg-primary py-3 text-sm font-medium text-white shadow-lg shadow-primary/25 transition hover:bg-primary/90 disabled:opacity-50"
            >
              {loading ? "Sending code…" : "Send reset code"}
            </button>
          </form>
        )}

        {step === "otp" && (
          <form onSubmit={handleOtpSubmit} className="space-y-5">
            <label className="block">
              <span className="text-xs font-medium text-white/60">Email</span>
              <input
                type="email"
                value={email.trim().toLowerCase()}
                disabled
                readOnly
                className="mt-2 w-full cursor-not-allowed rounded-lg border border-glassBorder bg-white/[0.04] px-4 py-3 text-sm text-white/70"
              />
            </label>
            <label className="block">
              <span className="text-xs font-medium text-white/60">
                Verification code
              </span>
              <input
                type="text"
                inputMode="numeric"
                autoComplete="one-time-code"
                pattern="[0-9]*"
                maxLength={6}
                required
                value={otp}
                onChange={(e) =>
                  setOtp(e.target.value.replace(/\D/g, "").slice(0, 6))
                }
                disabled={loading}
                className="mt-2 w-full rounded-lg border border-glassBorder bg-black/40 px-4 py-3 text-center font-mono text-lg tracking-[0.4em] text-white outline-none ring-primary/30 focus:ring-2 disabled:opacity-50"
                placeholder="000000"
              />
            </label>
            <div className="flex flex-col gap-3 sm:flex-row sm:justify-between">
              <button
                type="button"
                disabled={loading}
                onClick={() => {
                  setStep("email");
                  setError(null);
                }}
                className="rounded-lg px-4 py-3 text-sm font-medium text-white/70 transition hover:bg-white/10 disabled:opacity-50"
              >
                Back
              </button>
              <button
                type="submit"
                disabled={loading || otp.length !== 6}
                className="rounded-lg bg-primary px-6 py-3 text-sm font-medium text-white shadow-lg shadow-primary/25 transition hover:bg-primary/90 disabled:opacity-50 sm:ml-auto"
              >
                Continue
              </button>
            </div>
          </form>
        )}

        {step === "password" && (
          <form onSubmit={handlePasswordSubmit} className="space-y-5">
            <label className="block">
              <span className="text-xs font-medium text-white/60">
                New password
              </span>
              <input
                type="password"
                autoComplete="new-password"
                required
                minLength={8}
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                disabled={loading}
                className="mt-2 w-full rounded-lg border border-glassBorder bg-black/40 px-4 py-3 text-sm text-white outline-none ring-primary/30 placeholder:text-white/35 focus:ring-2 disabled:opacity-50"
                placeholder="At least 8 characters"
              />
            </label>
            <label className="block">
              <span className="text-xs font-medium text-white/60">
                Confirm password
              </span>
              <input
                type="password"
                autoComplete="new-password"
                required
                minLength={8}
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                disabled={loading}
                className="mt-2 w-full rounded-lg border border-glassBorder bg-black/40 px-4 py-3 text-sm text-white outline-none ring-primary/30 placeholder:text-white/35 focus:ring-2 disabled:opacity-50"
                placeholder="Repeat password"
              />
            </label>
            <div className="flex flex-col gap-3 sm:flex-row sm:justify-between">
              <button
                type="button"
                disabled={loading}
                onClick={() => {
                  setStep("otp");
                  setError(null);
                }}
                className="rounded-lg px-4 py-3 text-sm font-medium text-white/70 transition hover:bg-white/10 disabled:opacity-50"
              >
                Back
              </button>
              <button
                type="submit"
                disabled={loading}
                className="rounded-lg bg-primary px-6 py-3 text-sm font-medium text-white shadow-lg shadow-primary/25 transition hover:bg-primary/90 disabled:opacity-50 sm:ml-auto"
              >
                {loading ? "Resetting…" : "Reset password"}
              </button>
            </div>
          </form>
        )}

        <p className="mt-8 text-center text-sm text-white/55">
          Remember your password?{" "}
          <Link
            href="/login"
            className="font-medium text-primary underline-offset-2 transition hover:underline"
          >
            Sign in
          </Link>
        </p>
      </div>
    </div>
  );
}
