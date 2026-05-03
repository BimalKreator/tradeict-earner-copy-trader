"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";
import { getPublicApiBase } from "@/lib/publicApi";

const AUTH_API = `${getPublicApiBase()}/auth`;

type Step = "email" | "otp";

function LoginForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const registeredSuccess = searchParams.get("registered") === "1";

  const [step, setStep] = useState<Step>("email");
  const [email, setEmail] = useState("");
  const [otpCode, setOtpCode] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSendOtp(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const res = await fetch(`${AUTH_API}/send-login-otp`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: email.trim().toLowerCase() }),
      });
      const body: unknown = await res.json().catch(() => ({}));
      if (!res.ok) {
        const msg =
          typeof body === "object" &&
          body !== null &&
          "error" in body &&
          typeof (body as { error?: unknown }).error === "string"
            ? (body as { error: string }).error
            : `Request failed (${res.status})`;
        throw new Error(msg);
      }
      setStep("otp");
      setOtpCode("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not send OTP");
    } finally {
      setLoading(false);
    }
  }

  async function handleVerifyOtp(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const res = await fetch(`${AUTH_API}/verify-otp`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: email.trim().toLowerCase(),
          otpCode: otpCode.trim(),
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
            : `Verification failed (${res.status})`;
        throw new Error(msg);
      }
      if (
        typeof body !== "object" ||
        body === null ||
        !("token" in body) ||
        typeof (body as { token?: unknown }).token !== "string"
      ) {
        throw new Error("Invalid response: missing token");
      }
      const token = (body as { token: string }).token;
      localStorage.setItem("token", token);
      router.push("/dashboard");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Verification failed");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4 py-12">
      <div className="glass-card w-full max-w-md border border-glassBorder p-8 shadow-2xl">
        <div className="mb-8 text-center">
          <p className="text-xs font-medium uppercase tracking-widest text-primary">
            TradeICT Earner
          </p>
          <h1 className="mt-2 text-2xl font-semibold text-white">
            {step === "email" ? "Sign in" : "Enter code"}
          </h1>
          <p className="mt-2 text-sm text-white/55">
            {step === "email"
              ? "We’ll email you a one-time code."
              : "Check your inbox for the 6-digit code."}
          </p>
        </div>

        {registeredSuccess && step === "email" && (
          <div className="mb-6 rounded-lg border border-emerald-500/40 bg-emerald-500/10 px-4 py-3 text-sm text-emerald-100">
            Account created successfully. Sign in with your email and the code we send you.
          </div>
        )}

        {error && (
          <div className="mb-6 rounded-lg border border-red-500/40 bg-red-500/10 px-4 py-3 text-sm text-red-200">
            {error}
          </div>
        )}

        {step === "email" ? (
          <form onSubmit={handleSendOtp} className="space-y-5">
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
              {loading ? "Sending…" : "Send OTP"}
            </button>
          </form>
        ) : (
          <form onSubmit={handleVerifyOtp} className="space-y-5">
            <label className="block">
              <span className="text-xs font-medium text-white/60">Email</span>
              <input
                type="email"
                value={email}
                disabled
                readOnly
                className="mt-2 w-full cursor-not-allowed rounded-lg border border-glassBorder bg-white/[0.04] px-4 py-3 text-sm text-white/70"
              />
            </label>
            <label className="block">
              <span className="text-xs font-medium text-white/60">
                One-time code
              </span>
              <input
                type="text"
                inputMode="numeric"
                autoComplete="one-time-code"
                pattern="[0-9]*"
                maxLength={6}
                required
                value={otpCode}
                onChange={(e) =>
                  setOtpCode(e.target.value.replace(/\D/g, "").slice(0, 6))
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
                  setOtpCode("");
                }}
                className="rounded-lg px-4 py-3 text-sm font-medium text-white/70 transition hover:bg-white/10 disabled:opacity-50"
              >
                Change email
              </button>
              <button
                type="submit"
                disabled={loading || otpCode.length !== 6}
                className="rounded-lg bg-primary px-6 py-3 text-sm font-medium text-white shadow-lg shadow-primary/25 transition hover:bg-primary/90 disabled:opacity-50 sm:ml-auto"
              >
                {loading ? "Verifying…" : "Verify & Login"}
              </button>
            </div>
          </form>
        )}

        <p className="mt-8 text-center text-sm text-white/55">
          Don&apos;t have an account?{" "}
          <Link
            href="/signup"
            className="font-medium text-primary underline-offset-2 transition hover:underline"
          >
            Sign up
          </Link>
        </p>
      </div>
    </div>
  );
}

export default function LoginPage() {
  return (
    <Suspense
      fallback={
        <div className="flex min-h-screen items-center justify-center bg-background px-4 py-12">
          <div className="glass-card w-full max-w-md border border-glassBorder p-8 shadow-2xl">
            <div className="h-48 animate-pulse rounded-lg bg-white/5" />
          </div>
        </div>
      }
    >
      <LoginForm />
    </Suspense>
  );
}
