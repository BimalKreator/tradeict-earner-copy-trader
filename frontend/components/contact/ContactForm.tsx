"use client";

import { useState } from "react";
import { COMPANY } from "@/lib/company";

export function ContactForm() {
  const [submitted, setSubmitted] = useState(false);

  function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setSubmitted(true);
  }

  return (
    <div className="rounded-xl border border-white/10 bg-slate-900/50 p-6">
      <h2 className="text-lg font-semibold text-white">Send a message</h2>
      <p className="mt-1 text-sm text-white/55">
        For urgent billing issues, email{" "}
        <a href={`mailto:${COMPANY.supportEmail}`} className="text-cyan-400 hover:underline">
          {COMPANY.supportEmail}
        </a>{" "}
        directly.
      </p>

      {submitted ? (
        <p className="mt-6 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-4 py-3 text-sm text-emerald-200">
          Thank you. Your message has been recorded locally. Our team will respond via email when
          inbox integration is enabled. For immediate help, use the email or phone above.
        </p>
      ) : (
        <form onSubmit={handleSubmit} className="mt-6 space-y-4">
          <label className="block text-sm text-white/70">
            Full name
            <input
              type="text"
              name="name"
              required
              className="mt-1 w-full rounded-lg border border-white/15 bg-black/40 px-3 py-2 text-white outline-none focus:ring-2 focus:ring-cyan-500/40"
            />
          </label>
          <label className="block text-sm text-white/70">
            Email
            <input
              type="email"
              name="email"
              required
              className="mt-1 w-full rounded-lg border border-white/15 bg-black/40 px-3 py-2 text-white outline-none focus:ring-2 focus:ring-cyan-500/40"
            />
          </label>
          <label className="block text-sm text-white/70">
            Subject
            <select
              name="subject"
              className="mt-1 w-full rounded-lg border border-white/15 bg-black/40 px-3 py-2 text-white outline-none focus:ring-2 focus:ring-cyan-500/40"
            >
              <option value="billing">Billing / payments</option>
              <option value="technical">Technical support</option>
              <option value="compliance">Compliance / legal</option>
              <option value="other">Other</option>
            </select>
          </label>
          <label className="block text-sm text-white/70">
            Message
            <textarea
              name="message"
              rows={5}
              required
              className="mt-1 w-full resize-y rounded-lg border border-white/15 bg-black/40 px-3 py-2 text-white outline-none focus:ring-2 focus:ring-cyan-500/40"
            />
          </label>
          <button
            type="submit"
            className="w-full rounded-lg bg-cyan-600 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-cyan-500"
          >
            Submit
          </button>
        </form>
      )}
    </div>
  );
}
