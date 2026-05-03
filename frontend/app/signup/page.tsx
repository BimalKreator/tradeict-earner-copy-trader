"use client";

import Link from "next/link";
import { useState, type FormEvent } from "react";

export default function SignupPage() {
  const [fullName, setFullName] = useState("");
  const [email, setEmail] = useState("");
  const [mobile, setMobile] = useState("");
  const [password, setPassword] = useState("");
  const [agreedToTerms, setAgreedToTerms] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!agreedToTerms) return;
    setSubmitting(true);
    try {
      // Registration API can be wired here (fullName, email, mobile, password).
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4 py-12">
      <div className="glass-card w-full max-w-md border border-glassBorder p-8 shadow-2xl">
        <div className="mb-8 text-center">
          <p className="text-xs font-medium uppercase tracking-widest text-primary">
            TradeICT Earner
          </p>
          <h1 className="mt-2 text-2xl font-semibold text-white">Create an account</h1>
          <p className="mt-2 text-sm text-white/55">
            Join with your details and agree to our policies to continue.
          </p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-5">
          <label className="block">
            <span className="text-xs font-medium text-white/60">Full Name</span>
            <input
              type="text"
              name="fullName"
              autoComplete="name"
              required
              value={fullName}
              onChange={(e) => setFullName(e.target.value)}
              disabled={submitting}
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
              disabled={submitting}
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
              disabled={submitting}
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
              disabled={submitting}
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
                disabled={submitting}
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
            disabled={submitting || !agreedToTerms}
            className="w-full rounded-lg bg-primary py-3 text-sm font-semibold text-white shadow-lg shadow-primary/25 transition hover:bg-primary/90 disabled:pointer-events-none disabled:opacity-40"
          >
            {submitting ? "Signing up…" : "Sign Up"}
          </button>
        </form>

        <p className="mt-8 text-center text-sm text-white/55">
          Already have an account?{" "}
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
