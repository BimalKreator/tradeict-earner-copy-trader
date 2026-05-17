import type { Metadata } from "next";
import type { ReactNode } from "react";
import { ContactForm } from "@/components/contact/ContactForm";
import { LegalPageShell } from "@/components/legal/LegalPageShell";
import { COMPANY } from "@/lib/company";

export const metadata: Metadata = {
  title: "Contact Us",
  description: `Contact ${COMPANY.legalName} — support for ${COMPANY.productName}.`,
};

function DetailRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <dt className="text-xs font-medium uppercase tracking-wider text-white/45">{label}</dt>
      <dd className="mt-1">{children}</dd>
    </div>
  );
}

export default function ContactPage() {
  return (
    <LegalPageShell>
      <div className="space-y-10">
        <header className="space-y-2 border-b border-white/10 pb-8">
          <h1 className="text-3xl font-bold tracking-tight text-white sm:text-4xl">Contact Us</h1>
          <p className="text-[15px] leading-relaxed text-white/75">
            Reach {COMPANY.legalName} for billing, technical support, compliance, or partnership
            inquiries related to {COMPANY.productName}.
          </p>
        </header>

        <section className="grid gap-8 lg:grid-cols-2">
          <div className="space-y-6 rounded-xl border border-white/10 bg-slate-900/50 p-6">
            <h2 className="text-lg font-semibold text-white">Company details</h2>
            <dl className="space-y-4 text-sm text-white/75">
              <DetailRow label="Legal name">
                <span className="text-white">{COMPANY.legalName}</span>
              </DetailRow>
              <DetailRow label="Registered address">{COMPANY.address}</DetailRow>
              <DetailRow label="GSTIN">
                <span className="font-mono text-white/90">{COMPANY.gstin}</span>
              </DetailRow>
              <DetailRow label="Email">
                <a href={`mailto:${COMPANY.supportEmail}`} className="text-cyan-400 hover:underline">
                  {COMPANY.supportEmail}
                </a>
              </DetailRow>
              <DetailRow label="Phone">
                <a href={`tel:${COMPANY.supportPhoneTel}`} className="text-cyan-400 hover:underline">
                  {COMPANY.supportPhone}
                </a>
              </DetailRow>
              <DetailRow label="Website">
                <a
                  href={COMPANY.domain}
                  className="text-cyan-400 hover:underline"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  {COMPANY.domain}
                </a>
              </DetailRow>
            </dl>
            <p className="text-xs text-white/45">
              Support hours: Monday–Saturday, 10:00–18:00 IST (excluding public holidays). We aim to
              respond within 1–2 business days.
            </p>
          </div>

          <ContactForm />
        </section>
      </div>
    </LegalPageShell>
  );
}
