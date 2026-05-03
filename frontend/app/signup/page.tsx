"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
const AUTH_API = process.env.NEXT_PUBLIC_API_URL;

type Step = "details" | "otp";

async function parseApiError(res: Response): Promise<string> {
  const body: unknown = await res.json().catch(() => ({}));
  if (
    typeof body === "object" &&
    body !== null &&
    "error" in body &&
    typeof (body as { error: unknown }).error === "string"
  ) {
    return (body as { error: string }).error;
  }
  return `Request failed (${res.status})`;
}

export default function SignupPage() {
  const router = useRouter();
  const [step, setStep] = useState<Step>("details");
  const [fullName, setFullName] = useState("");
  const [email, setEmail] = useState("");
  const [mobile, setMobile] = useState("");
  const [password, setPassword] = useState("");
  const [otp, setOtp] = useState("");
  const [agreedToTerms, setAgreedToTerms] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleDetailsSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!agreedToTerms) return;
    setError(null);
    setLoading(true);
    try {
      const res = await fetch(`${AUTH_API}/auth/send-otp`, {
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
        err instanceof Error ? err.message : "Could not send verification code",
      );
    } finally {
      setLoading(false);
    }
  }

  async function handleOtpSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const res = await fetch(`${AUTH_API}/auth/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: fullName.trim(),
          email: email.trim().toLowerCase(),
          mobile: mobile.trim(),
          password,
          otp: otp.trim(),
        }),
      });
      if (!res.ok) {
        throw new Error(await parseApiError(res));
      }
      router.push("/login?registered=1");
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Registration failed",
      );
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
            {step === "details" ? "Create an account" : "Verify your email"}
          </h1>
          <p className="mt-2 text-sm text-white/55">
            {step === "details"
              ? "Join with your details and agree to our policies to continue."
              : "Enter the 6-digit code we sent to your email."}
          </p>
        </div>

        {error && (
          <div className="mb-6 rounded-lg border border-red-500/40 bg-red-500/10 px-4 py-3 text-sm text-red-200">
            {error}
          </div>
        )}

        {step === "details" ? (
          <form onSubmit={handleDetailsSubmit} className="space-y-5">
            <label className="block">
              <span className="text-xs font-medium text-white/60">Full Name</span>
              <input
                type="text"
                name="fullName"
                autoComplete="name"
                required
                value={fullName}
                onChange={(e) => setFullName(e.target.value)}
                disabled={loading}
                className="mt-2 w-full rounded-lg border border-glassBorder bg-black/40 px-4 py-3 text-sm text-white outline-none ring-primary/30 placeholder:text-white/35 focus:ring-2 disabled:opacity-50"
                placeholder="Jane Doe"
              />
            </label>

            <label className="block">
              <span className="text-xs font-medium text-white/60">Email Address</span>
              <input
                type="email"
                name="email"
                autoComplete="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                disabled={loading}
                className="mt-2 w-full rounded-lg border border-glassBorder bg-black/40 px-4 py-3 text-sm text-white outline-none ring-primary/30 placeholder:text-white/35 focus:ring-2 disabled:opacity-50"
                placeholder="you@example.com"
              />
            </label>

            <label className="block">
              <span className="text-xs font-medium text-white/60">Mobile Number</span>
              <input
                type="tel"
                name="mobile"
                autoComplete="tel"
                required
                value={mobile}
                onChange={(e) => setMobile(e.target.value)}
                disabled={loading}
                className="mt-2 w-full rounded-lg border border-glassBorder bg-black/40 px-4 py-3 text-sm text-white outline-none ring-primary/30 placeholder:text-white/35 focus:ring-2 disabled:opacity-50"
                placeholder="+1 555 000 0000"
              />
            </label>

            <label className="block">
              <span className="text-xs font-medium text-white/60">Password</span>
              <input
                type="password"
                name="password"
                autoComplete="new-password"
                required
                minLength={8}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                disabled={loading}
                className="mt-2 w-full rounded-lg border border-glassBorder bg-black/40 px-4 py-3 text-sm text-white outline-none ring-primary/30 placeholder:text-white/35 focus:ring-2 disabled:opacity-50"
                placeholder="At least 8 characters"
              />
            </label>

            <div className="pt-1">
              <label className="flex cursor-pointer gap-3 rounded-lg border border-glassBorder bg-white/[0.03] p-4 transition hover:bg-white/[0.06]">
                <input
                  type="checkbox"
                  checked={agreedToTerms}
                  onChange={(e) => setAgreedToTerms(e.target.checked)}
                  required
                  disabled={loading}
                  className="mt-0.5 h-4 w-4 shrink-0 rounded border-glassBorder bg-black/40 text-primary focus:ring-2 focus:ring-primary/40 disabled:opacity-50"
                />
                <span className="text-sm leading-snug text-white/75">
                  I agree to the{" "}
                  <Link
                    href="/legal/terms"
                    className="font-medium text-primary underline-offset-2 hover:underline"
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    Terms of Service
                  </Link>{" "}
                  and{" "}
                  <Link
                    href="/legal/privacy"
                    className="font-medium text-primary underline-offset-2 hover:underline"
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    Privacy Policy
                  </Link>
                  .
                </span>
              </label>
            </div>

            <button
              type="submit"
              disabled={loading || !agreedToTerms}
              className="w-full rounded-lg bg-primary py-3 text-sm font-semibold text-white shadow-lg shadow-primary/25 transition hover:bg-primary/90 disabled:pointer-events-none disabled:opacity-40"
            >
              {loading ? "Sending code…" : "Send verification code"}
            </button>
          </form>
        ) : (
          <form onSubmit={handleOtpSubmit} className="space-y-5">
            <p className="rounded-lg border border-glassBorder bg-white/[0.04] px-4 py-3 text-sm text-white/70">
              Signing up as{" "}
              <span className="font-medium text-white">{fullName.trim()}</span>
              <br />
              <span className="text-white/55">{email.trim().toLowerCase()}</span>
            </p>

            <label className="block">
              <span className="text-xs font-medium text-white/60">6-digit code</span>
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
                  setStep("details");
                  setError(null);
                  setOtp("");
                }}
                className="rounded-lg px-4 py-3 text-sm font-medium text-white/70 transition hover:bg-white/10 disabled:opacity-50"
              >
                Back to details
              </button>
              <button
                type="submit"
                disabled={loading || otp.length !== 6}
                className="rounded-lg bg-primary px-6 py-3 text-sm font-semibold text-white shadow-lg shadow-primary/25 transition hover:bg-primary/90 disabled:opacity-50 sm:ml-auto"
              >
                {loading ? "Creating account…" : "Verify & Sign Up"}
              </button>
            </div>
          </form>
        )}

        {step === "details" ? (
          <p className="mt-8 text-center text-sm text-white/55">
            Already have an account?{" "}
            <Link
              href="/login"
              className="font-medium text-primary underline-offset-2 transition hover:underline"
            >
              Sign in
            </Link>
          </p>
        ) : null}
      </div>
    </div>
  );
}
