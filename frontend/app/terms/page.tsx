import type { Metadata } from "next";
import { LegalPageShell, legalDocClass } from "@/components/legal/LegalPageShell";
import { COMPANY } from "@/lib/company";

export const metadata: Metadata = {
  title: "Terms & Conditions",
  description: `Terms of Service for ${COMPANY.productName} by ${COMPANY.legalName}.`,
};

export default function TermsPage() {
  return (
    <LegalPageShell>
      <article className={legalDocClass}>
        <header className="space-y-2 border-b border-white/10 pb-8">
          <h1 className="text-3xl font-bold tracking-tight text-white sm:text-4xl">
            Terms &amp; Conditions
          </h1>
          <p className="text-sm text-white/50">Last updated: May 17, 2026</p>
          <p>
            These Terms &amp; Conditions (&quot;Terms&quot;) govern access to and use of the{" "}
            <strong>{COMPANY.productName}</strong> platform at{" "}
            <a href={COMPANY.domain} className="text-cyan-400 hover:underline">
              {COMPANY.domain}
            </a>{" "}
            operated by <strong>{COMPANY.legalName}</strong> (&quot;Company,&quot; &quot;we,&quot;
            &quot;us&quot;). By registering, subscribing, or paying for services, you agree to
            these Terms.
          </p>
        </header>

        <section className="space-y-4">
          <h2>1. Nature of the service</h2>
          <p>
            {COMPANY.productName} is a software-as-a-service (SaaS) copy-trading and trade
            execution tool. The software connects to third-party exchanges (e.g. Delta Exchange)
            using API credentials you provide. We do <strong>not</strong> custody your funds,
            provide investment advice, portfolio management, or guaranteed returns.
          </p>
          <p>
            All trading decisions remain yours. The platform automates execution of strategies you
            subscribe to; it is not a recommendation to buy or sell any instrument.
          </p>
        </section>

        <section className="space-y-4">
          <h2>2. Revenue sharing &amp; fees</h2>
          <p>
            Fees may include strategy subscription charges and a <strong>revenue share</strong> on
            positive realized profit attributable to copy-traded strategies, as disclosed on our{" "}
            <a href="/pricing" className="text-cyan-400 hover:underline">
              Pricing
            </a>{" "}
            page and in your dashboard before payment. Revenue share is calculated on closed,
            realized PnL per strategy per billing period (high-water-mark methodology where
            applicable). GST and other taxes apply as per Indian law (GSTIN: {COMPANY.gstin}).
          </p>
          <p>
            You authorize us to raise invoices and collect amounts via our payment partner (e.g.
            Razorpay). Failure to pay may result in suspension of copy trading or strategy access.
          </p>
        </section>

        <section className="space-y-4">
          <h2>3. Risk acknowledgment</h2>
          <p>
            Cryptocurrency and derivatives trading involves substantial risk, including total loss
            of capital. Leverage, volatility, slippage, exchange outages, and API failures can
            cause unexpected outcomes. <strong>You trade at your own risk.</strong> You confirm
            that you understand these risks and that you are solely responsible for your trading
            activity and tax obligations.
          </p>
        </section>

        <section className="space-y-4">
          <h2>4. API keys &amp; account security</h2>
          <p>
            You are responsible for API permissions, key rotation, and securing your exchange and
            platform accounts. You grant us permission to use keys only to deliver the Service. See
            our{" "}
            <a href="/privacy" className="text-cyan-400 hover:underline">
              Privacy Policy
            </a>{" "}
            for data handling practices.
          </p>
        </section>

        <section className="space-y-4">
          <h2>5. No financial advice</h2>
          <p>
            Content, strategy descriptions, performance metrics, and communications are for
            informational purposes only and do not constitute financial, legal, or tax advice. Past
            performance does not guarantee future results.
          </p>
        </section>

        <section className="space-y-4">
          <h2>6. Eligibility</h2>
          <p>
            You must be at least 18 years old, legally competent to contract in India, and compliant
            with applicable laws including exchange KYC/AML requirements. You may not use the
            Service where prohibited by law.
          </p>
        </section>

        <section className="space-y-4">
          <h2>7. Acceptable use</h2>
          <ul>
            <li>No reverse engineering, abuse, or interference with the Service.</li>
            <li>No use for money laundering, fraud, or sanctions evasion.</li>
            <li>No misrepresentation of identity or payment instruments.</li>
          </ul>
        </section>

        <section className="space-y-4">
          <h2>8. Limitation of liability</h2>
          <p>
            To the maximum extent permitted by law, the Company is not liable for trading losses,
            indirect damages, or exchange/third-party failures. Our aggregate liability for any
            claim relating to the Service is limited to fees paid by you to us in the three (3)
            months preceding the claim.
          </p>
        </section>

        <section className="space-y-4">
          <h2>9. Termination</h2>
          <p>
            You may stop using the Service by disconnecting APIs and cancelling subscriptions.
            We may suspend or terminate access for breach of Terms, non-payment, or legal
            requirement. Provisions on fees owed, disclaimers, and liability survive termination.
          </p>
        </section>

        <section className="space-y-4">
          <h2>10. Governing law &amp; disputes</h2>
          <p>
            These Terms are governed by the laws of India. Courts at Kanpur Nagar, Uttar Pradesh
            shall have exclusive jurisdiction, subject to applicable consumer protection laws.
          </p>
        </section>

        <section className="space-y-4">
          <h2>11. Contact</h2>
          <p>
            {COMPANY.legalName}
            <br />
            {COMPANY.address}
            <br />
            Email:{" "}
            <a href={`mailto:${COMPANY.supportEmail}`} className="text-cyan-400 hover:underline">
              {COMPANY.supportEmail}
            </a>
            <br />
            Phone:{" "}
            <a href={`tel:${COMPANY.supportPhoneTel}`} className="text-cyan-400 hover:underline">
              {COMPANY.supportPhone}
            </a>
          </p>
        </section>
      </article>
    </LegalPageShell>
  );
}
