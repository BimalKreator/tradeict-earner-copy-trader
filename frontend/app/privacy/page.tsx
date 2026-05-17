import type { Metadata } from "next";
import { LegalPageShell, legalDocClass } from "@/components/legal/LegalPageShell";
import { COMPANY } from "@/lib/company";

export const metadata: Metadata = {
  title: "Privacy Policy",
  description: `Privacy Policy for ${COMPANY.productName} — data, API keys, and compliance.`,
};

export default function PrivacyPage() {
  return (
    <LegalPageShell>
      <article className={legalDocClass}>
        <header className="space-y-2 border-b border-white/10 pb-8">
          <h1 className="text-3xl font-bold tracking-tight text-white sm:text-4xl">
            Privacy Policy
          </h1>
          <p className="text-sm text-white/50">Last updated: May 17, 2026</p>
          <p>
            <strong>{COMPANY.legalName}</strong> (&quot;we,&quot; &quot;us&quot;) operates{" "}
            {COMPANY.productName}. This Privacy Policy explains how we collect, use, store, and
            protect personal data when you use our website and services.
          </p>
        </header>

        <section className="space-y-4">
          <h2>1. Data controller</h2>
          <p>
            {COMPANY.legalName}
            <br />
            {COMPANY.address}
            <br />
            Email: {COMPANY.supportEmail} · Phone: {COMPANY.supportPhone}
          </p>
        </section>

        <section className="space-y-4">
          <h2>2. Information we collect</h2>
          <ul>
            <li>Account data: name, email, mobile, KYC-related fields you submit.</li>
            <li>
              Exchange API credentials (encrypted) to execute copy trades on your linked account.
            </li>
            <li>Trading metadata: symbols, sizes, PnL, invoices, subscription status.</li>
            <li>Payment records from our payment gateway (transaction IDs, amounts, status).</li>
            <li>Technical logs: IP address, device/browser, session and security logs.</li>
            <li>Communications with support (email, tickets).</li>
          </ul>
        </section>

        <section className="space-y-4">
          <h2>3. API keys &amp; security</h2>
          <p>
            API keys and secrets are stored using industry-standard encryption at rest and
            transmitted over TLS. We use keys only to perform actions you authorize (e.g. placing
            orders per subscribed strategies). We recommend trade-only permissions without
            withdrawal rights, and periodic key rotation on your exchange.
          </p>
          <p>
            No system is 100% secure. You are responsible for safeguarding your platform password
            and exchange credentials.
          </p>
        </section>

        <section className="space-y-4">
          <h2>4. How we use data</h2>
          <ul>
            <li>Provide, maintain, and improve the copy-trading Service.</li>
            <li>Bill revenue share and subscription fees; send invoices and reminders.</li>
            <li>Fraud prevention, compliance, and legal obligations.</li>
            <li>Customer support and service notifications.</li>
          </ul>
          <p>We do not sell your personal data to third parties for marketing.</p>
        </section>

        <section className="space-y-4">
          <h2>5. Sharing with third parties</h2>
          <ul>
            <li>Payment processors (e.g. Cashfree) for collections.</li>
            <li>Cloud hosting and infrastructure providers under confidentiality obligations.</li>
            <li>Exchanges/brokers you connect (data flows as required for trading).</li>
            <li>Authorities when required by applicable law or court order.</li>
          </ul>
        </section>

        <section className="space-y-4">
          <h2>6. Retention</h2>
          <p>
            We retain data while your account is active and as needed for accounting, tax, and
            dispute resolution (typically up to 8 years for financial records where required by
            Indian law). You may request deletion subject to legal retention requirements.
          </p>
        </section>

        <section className="space-y-4">
          <h2>7. Your rights (India &amp; GDPR-style principles)</h2>
          <p>
            Subject to the Information Technology Act, 2000, SPDI Rules, and applicable data
            protection laws, you may request access, correction, or deletion of personal data by
            contacting {COMPANY.supportEmail}. EU/UK users with lawful basis may exercise GDPR
            rights where applicable; we will respond within reasonable timelines.
          </p>
        </section>

        <section className="space-y-4">
          <h2>8. Cookies</h2>
          <p>
            We use essential cookies and local storage for authentication and preferences. See{" "}
            <a href="/legal/cookies" className="text-cyan-400 hover:underline">
              Cookies Policy
            </a>{" "}
            for details.
          </p>
        </section>

        <section className="space-y-4">
          <h2>9. Children</h2>
          <p>The Service is not directed to individuals under 18.</p>
        </section>

        <section className="space-y-4">
          <h2>10. Changes</h2>
          <p>
            We may update this Policy. Material changes will be posted on this page with an updated
            date. Continued use after changes constitutes acceptance.
          </p>
        </section>

        <section className="space-y-4">
          <h2>11. Grievance officer</h2>
          <p>
            For privacy concerns, contact:{" "}
            <a href={`mailto:${COMPANY.supportEmail}`} className="text-cyan-400 hover:underline">
              {COMPANY.supportEmail}
            </a>
            . We aim to acknowledge complaints within 7 business days.
          </p>
        </section>
      </article>
    </LegalPageShell>
  );
}
