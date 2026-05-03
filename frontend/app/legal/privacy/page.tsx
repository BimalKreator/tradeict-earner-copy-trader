import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Privacy Policy",
  description:
    "How TradeICT Earner collects, uses, and protects personal data for its SaaS copy-trading platform.",
};

const docClass =
  "space-y-6 text-[15px] leading-relaxed text-white/85 [&_strong]:font-semibold [&_strong]:text-white";

export default function PrivacyPolicyPage() {
  return (
    <article className={docClass}>
      <header className="space-y-2 border-b border-white/10 pb-8">
        <h1 className="text-3xl font-bold tracking-tight text-white sm:text-4xl">Privacy Policy</h1>
        <p className="text-sm text-white/50">Last updated: May 3, 2026</p>
        <p className="text-sm text-white/60">
          TradeICT (“we,” “us,” or “our”) operates TradeICT Earner, a SaaS platform that provides
          automated algorithmic copy-trading execution software connecting to your exchange or
          broker accounts via API. This Privacy Policy describes how we collect, use, disclose, and
          safeguard personal information when you use our website, applications, and related services
          (the “Service”).
        </p>
      </header>

      <section className="space-y-4">
        <h2 className="text-xl font-semibold text-white">1. Important context</h2>
        <p>
          <strong>Non-custodial trading.</strong> We do not custody your trading funds or digital
          assets. Your balances remain with third-party exchanges or brokers. We process information
          needed to operate the Service, including API connectivity and account authentication.
        </p>
      </section>

      <section className="space-y-4">
        <h2 className="text-xl font-semibold text-white">2. Information we collect</h2>
        <p>Depending on how you use the Service, we may collect:</p>
        <ul className="list-disc space-y-2 pl-6">
          <li>
            <strong>Account and contact data:</strong> email address, name or username, and
            authentication identifiers (e.g., for login or OTP verification).
          </li>
          <li>
            <strong>Technical data:</strong> IP address, device type, browser, approximate location
            derived from IP, logs, timestamps, and diagnostic information for security and reliability.
          </li>
          <li>
            <strong>API and integration data:</strong> exchange or broker identifiers, API key
            metadata (we strongly encourage permission-scoped keys), connection status, and
            operational logs related to order routing or automation—only as needed to provide the
            Service you configure.
          </li>
          <li>
            <strong>Usage data:</strong> feature usage, subscription tier, support interactions, and
            communications you send to us.
          </li>
          <li>
            <strong>Billing data:</strong> processed by payment processors; we typically receive
            limited billing confirmation rather than full card numbers.
          </li>
        </ul>
      </section>

      <section className="space-y-4">
        <h2 className="text-xl font-semibold text-white">3. How we use information</h2>
        <p>We use personal information to:</p>
        <ul className="list-disc space-y-2 pl-6">
          <li>Provide, operate, and improve the Service, including API-linked execution features;</li>
          <li>Authenticate users and prevent fraud, abuse, and security incidents;</li>
          <li>Communicate about your account, updates, and important notices;</li>
          <li>Comply with legal obligations and enforce our terms;</li>
          <li>Analyze aggregated or de-identified usage to improve product performance.</li>
        </ul>
      </section>

      <section className="space-y-4">
        <h2 className="text-xl font-semibold text-white">4. Legal bases (where applicable)</h2>
        <p>
          Where GDPR or similar laws apply, we rely on bases such as: performance of a contract,
          legitimate interests (security, analytics, product improvement—balanced against your
          rights), consent where required (e.g., certain cookies or marketing), and legal obligation.
        </p>
      </section>

      <section className="space-y-4">
        <h2 className="text-xl font-semibold text-white">5. Sharing and subprocessors</h2>
        <p>
          We may share information with service providers who assist us (hosting, analytics, email
          delivery, payment processing, customer support), subject to contractual safeguards. We may
          disclose information if required by law, to protect rights and safety, or in connection
          with a merger or asset transfer. We do not sell your personal information as “sale” is
          commonly understood under U.S. state privacy laws, except as disclosed and permitted when
          you opt in where required.
        </p>
      </section>

      <section className="space-y-4">
        <h2 className="text-xl font-semibold text-white">6. International transfers</h2>
        <p>
          If you access the Service from outside our primary operating region, your information may
          be processed in countries with different data-protection laws. We implement appropriate
          safeguards where required (e.g., standard contractual clauses).
        </p>
      </section>

      <section className="space-y-4">
        <h2 className="text-xl font-semibold text-white">7. Retention</h2>
        <p>
          We retain personal information as long as necessary to provide the Service, comply with
          law, resolve disputes, and enforce agreements. Technical logs may be retained for shorter
          or longer periods based on security and operational needs.
        </p>
      </section>

      <section className="space-y-4">
        <h2 className="text-xl font-semibold text-white">8. Security</h2>
        <p>
          We use administrative, technical, and organizational measures designed to protect
          personal information. No method of transmission or storage is completely secure; you use
          the Service at your own risk beyond our reasonable safeguards.
        </p>
      </section>

      <section className="space-y-4">
        <h2 className="text-xl font-semibold text-white">9. Your rights</h2>
        <p>
          Depending on your location, you may have rights to access, correct, delete, or port your
          personal information, object to or restrict certain processing, withdraw consent where
          processing is consent-based, and lodge a complaint with a supervisory authority. Contact
          us to exercise rights; we will respond as required by law.
        </p>
      </section>

      <section className="space-y-4">
        <h2 className="text-xl font-semibold text-white">10. Children</h2>
        <p>
          The Service is not directed to individuals under the age required to enter a binding
          contract in their jurisdiction. We do not knowingly collect personal information from
          children.
        </p>
      </section>

      <section className="space-y-4">
        <h2 className="text-xl font-semibold text-white">11. Changes to this policy</h2>
        <p>
          We may update this Privacy Policy from time to time. We will post the revised policy and
          update the “Last updated” date. Material changes may require additional notice where
          required by law.
        </p>
      </section>

      <section className="space-y-4">
        <h2 className="text-xl font-semibold text-white">12. Contact</h2>
        <p>
          For privacy inquiries or requests, contact us through the contact information provided on
          the TradeICT Earner website.
        </p>
      </section>

      <footer className="border-t border-white/10 pt-8 text-sm text-white/50">
        <p>
          This Privacy Policy is provided for general information and does not constitute legal
          advice.
        </p>
      </footer>
    </article>
  );
}
