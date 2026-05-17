import Link from "next/link";
import { COMPANY } from "@/lib/company";

const complianceLinks = [
  { href: "/terms", label: "Terms & Conditions" },
  { href: "/privacy", label: "Privacy Policy" },
  { href: "/refund", label: "Refund & Cancellation Policy" },
  { href: "/contact", label: "Contact Us" },
  { href: "/pricing", label: "Pricing" },
] as const;

const additionalLegal = [
  { href: "/legal/risk", label: "Risk Disclaimer" },
  { href: "/legal/cookies", label: "Cookies Policy" },
] as const;

export function Footer() {
  return (
    <footer className="mt-auto border-t border-white/10 bg-slate-950/90 px-4 py-10 sm:px-6 lg:px-8">
      <div className="mx-auto max-w-6xl space-y-8">
        <div className="grid gap-8 md:grid-cols-2 lg:grid-cols-4">
          <div className="space-y-3 lg:col-span-1">
            <p className="text-lg font-semibold text-white">
              <span className="text-cyan-400">{COMPANY.productName}</span>
            </p>
            <p className="text-sm font-medium text-white/80">{COMPANY.legalName}</p>
            <p className="text-sm leading-relaxed text-white/55">{COMPANY.address}</p>
            <p className="text-sm text-white/60">
              GSTIN: <span className="font-mono text-white/80">{COMPANY.gstin}</span>
            </p>
          </div>

          <div className="space-y-3">
            <p className="text-xs font-semibold uppercase tracking-wider text-white/45">
              Support
            </p>
            <ul className="space-y-2 text-sm">
              <li>
                <a
                  href={`mailto:${COMPANY.supportEmail}`}
                  className="text-white/70 transition hover:text-cyan-300"
                >
                  {COMPANY.supportEmail}
                </a>
              </li>
              <li>
                <a
                  href={`tel:${COMPANY.supportPhoneTel}`}
                  className="text-white/70 transition hover:text-cyan-300"
                >
                  {COMPANY.supportPhone}
                </a>
              </li>
              <li>
                <a
                  href={COMPANY.domain}
                  className="text-white/70 transition hover:text-cyan-300"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  {COMPANY.domain.replace(/^https?:\/\//, "")}
                </a>
              </li>
            </ul>
          </div>

          <nav aria-label="Partner with us" className="space-y-3">
            <p className="text-xs font-semibold uppercase tracking-wider text-white/45">
              Partner With Us
            </p>
            <ul className="space-y-2">
              <li>
                <Link
                  href="/experts"
                  className="text-sm font-medium text-cyan-400/90 underline-offset-2 transition hover:text-cyan-300 hover:underline"
                >
                  Become an Expert Trader
                </Link>
              </li>
            </ul>
          </nav>

          <nav aria-label="Legal and policies" className="space-y-3">
            <p className="text-xs font-semibold uppercase tracking-wider text-white/45">
              Policies
            </p>
            <ul className="space-y-2">
              {complianceLinks.map(({ href, label }) => (
                <li key={href}>
                  <Link
                    href={href}
                    className="text-sm text-white/70 underline-offset-2 transition hover:text-cyan-300 hover:underline"
                  >
                    {label}
                  </Link>
                </li>
              ))}
            </ul>
            <ul className="mt-4 flex flex-wrap gap-x-4 gap-y-1 border-t border-white/10 pt-3">
              {additionalLegal.map(({ href, label }) => (
                <li key={href}>
                  <Link
                    href={href}
                    className="text-xs text-white/45 transition hover:text-white/70"
                  >
                    {label}
                  </Link>
                </li>
              ))}
            </ul>
          </nav>
        </div>

        <p className="border-t border-white/10 pt-6 text-center text-xs text-white/40">
          {COMPANY.legalName} © 2025. All rights reserved. Payments processed via authorized
          payment partners (e.g. Cashfree). Trading involves substantial risk of loss.
        </p>
      </div>
    </footer>
  );
}
