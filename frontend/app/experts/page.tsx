import type { Metadata } from "next";
import { ExpertApplicationForm } from "@/components/experts/ExpertApplicationForm";
import { LegalPageShell } from "@/components/legal/LegalPageShell";
import { COMPANY } from "@/lib/company";

export const metadata: Metadata = {
  title: "Become an Expert Trader",
  description: `Apply to list your strategy on ${COMPANY.productName} and earn revenue share from copiers.`,
};

const benefits = [
  {
    title: "Reach serious copiers",
    body: "List on a regulated copy-trading platform with transparent billing and high-water-mark revenue share.",
  },
  {
    title: "We handle infrastructure",
    body: "API connectivity, subscriber onboarding, billing, and compliance pages — you focus on execution.",
  },
  {
    title: "Fair revenue share",
    body: "Set your expected profit-share percentage; we align incentives with your subscribers' realized PnL.",
  },
] as const;

export default function ExpertsPage() {
  return (
    <LegalPageShell>
      <div className="space-y-14">
        <header className="relative overflow-hidden rounded-2xl border border-cyan-500/20 bg-gradient-to-br from-slate-900 via-slate-950 to-cyan-950/40 px-6 py-12 sm:px-10 sm:py-14">
          <div
            className="pointer-events-none absolute -right-20 -top-20 h-64 w-64 rounded-full bg-cyan-500/10 blur-3xl"
            aria-hidden
          />
          <p className="text-xs font-semibold uppercase tracking-widest text-cyan-400/90">
            Expert Traders Program
          </p>
          <h1 className="mt-3 max-w-2xl text-3xl font-bold tracking-tight text-white sm:text-4xl lg:text-[2.35rem] lg:leading-tight">
            Monetize Your Trading Expertise. Let thousands copy your successful strategies.
          </h1>
          <p className="mt-4 max-w-xl text-[15px] leading-relaxed text-white/70">
            Partner with {COMPANY.legalName} to publish your edge on {COMPANY.productName}. Tell us
            about your strategy, capital requirements, and revenue expectations — our team will
            guide you through integration.
          </p>
        </header>

        <section className="grid gap-6 sm:grid-cols-3">
          {benefits.map(({ title, body }) => (
            <div
              key={title}
              className="rounded-xl border border-white/10 bg-slate-900/40 p-5 transition hover:border-cyan-500/25"
            >
              <h2 className="text-base font-semibold text-white">{title}</h2>
              <p className="mt-2 text-sm leading-relaxed text-white/60">{body}</p>
            </div>
          ))}
        </section>

        <ExpertApplicationForm />
      </div>
    </LegalPageShell>
  );
}
