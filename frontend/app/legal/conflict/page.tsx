import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Conflict of Interest Policy",
  description:
    "How TradeICT Earner identifies and manages conflicts of interest for its SaaS copy-trading platform.",
};

const docClass =
  "space-y-6 text-[15px] leading-relaxed text-white/85 [&_strong]:font-semibold [&_strong]:text-white";

export default function ConflictOfInterestPage() {
  return (
    <article className={docClass}>
      <header className="space-y-2 border-b border-white/10 pb-8">
        <h1 className="text-3xl font-bold tracking-tight text-white sm:text-4xl">
          Conflict of Interest Policy
        </h1>
        <p className="text-sm text-white/50">Last updated: May 3, 2026</p>
        <p className="text-sm text-white/60">
          TradeICT (“we,” “us,” or “our”) operates TradeICT Earner, a non-custodial SaaS platform
          that provides automated algorithmic copy-trading execution by connecting to user exchange
          accounts via API. We do not hold user trading funds. This policy describes how we approach
          conflicts of interest and related duties of fairness and transparency.
        </p>
      </header>

      <section className="space-y-4">
        <h2 className="text-xl font-semibold text-white">1. Purpose and scope</h2>
        <p>
          A conflict of interest arises when our interests, or the interests of related parties,
          could materially compromise—or appear to compromise—our ability to act fairly toward users.
          This policy applies to TradeICT, its affiliates, directors, officers, employees,
          contractors, and anyone acting on our behalf.
        </p>
      </section>

      <section className="space-y-4">
        <h2 className="text-xl font-semibold text-white">2. Our business model</h2>
        <p>
          TradeICT Earner generates revenue from software subscriptions, fees, or related services
          as described in our offering materials. We are not a custodian of your trading capital;
          fees may nonetheless create incentives to grow usage of the Service. We aim to align
          product design with user safety and clear disclosure rather than undisclosed cross-interests.
        </p>
      </section>

      <section className="space-y-4">
        <h2 className="text-xl font-semibold text-white">3. Types of potential conflicts</h2>
        <p>Examples of situations we monitor include:</p>
        <ul className="list-disc space-y-2 pl-6">
          <li>
            <strong>Strategy or marketplace relationships:</strong> relationships with strategy
            publishers, affiliates, or partners who may promote or distribute trading approaches;
          </li>
          <li>
            <strong>Commercial partnerships:</strong> arrangements with exchanges, brokers, data
            vendors, or referral programs that could influence promotion or integration priorities;
          </li>
          <li>
            <strong>Internal trading or personal accounts:</strong> personal trading by personnel in
            related markets where information asymmetry could arise;
          </li>
          <li>
            <strong>Corporate transactions:</strong> investments, acquisitions, or financing that
            could affect product roadmap or support priorities;
          </li>
          <li>
            <strong>Support and routing:</strong> prioritization of incidents or features where a
            conflict could favor one user group over another without justification.
          </li>
        </ul>
      </section>

      <section className="space-y-4">
        <h2 className="text-xl font-semibold text-white">4. Mitigation measures</h2>
        <p>We use reasonable measures to identify and mitigate conflicts, which may include:</p>
        <ul className="list-disc space-y-2 pl-6">
          <li>Internal policies on gifts, outside business activities, and personal trading;</li>
          <li>Access controls and confidentiality safeguards for sensitive product or user information;</li>
          <li>Disclosure of material relationships where appropriate on our website or in-product;</li>
          <li>Segregation of duties where practicable for engineering, compliance review, and partnerships;</li>
          <li>Documentation of significant partnership or integration decisions.</li>
        </ul>
      </section>

      <section className="space-y-4">
        <h2 className="text-xl font-semibold text-white">5. No fiduciary relationship</h2>
        <p>
          Unless expressly agreed in a separate written agreement, we do not owe you a fiduciary
          duty in connection with the Service. You retain sole responsibility for trading decisions,
          API permissions, strategy selection, and risk management in your broker accounts.
        </p>
      </section>

      <section className="space-y-4">
        <h2 className="text-xl font-semibold text-white">6. Third-party strategies and users</h2>
        <p>
          If the Service displays strategies or “copy” relationships involving third parties, those
          parties may have their own economic interests. We do not guarantee independence of any
          third party; users should review disclosures provided by strategy operators and exchanges.
        </p>
      </section>

      <section className="space-y-4">
        <h2 className="text-xl font-semibold text-white">7. Reporting concerns</h2>
        <p>
          If you believe a conflict has not been adequately disclosed or managed, contact us through
          the channels listed on the TradeICT Earner website. We will review good-faith reports and
          respond as appropriate.
        </p>
      </section>

      <section className="space-y-4">
        <h2 className="text-xl font-semibold text-white">8. Updates</h2>
        <p>
          We may revise this policy to reflect changes in our business, regulation, or best
          practices. Material updates will be reflected in the “Last updated” date.
        </p>
      </section>

      <footer className="border-t border-white/10 pt-8 text-sm text-white/50">
        <p>
          This Conflict of Interest Policy is informational and does not constitute legal advice.
        </p>
      </footer>
    </article>
  );
}
