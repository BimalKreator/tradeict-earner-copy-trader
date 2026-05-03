import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Terms of Service",
  description:
    "Terms governing use of TradeICT Earner’s SaaS copy-trading execution software and related services.",
};

const docClass =
  "space-y-6 text-[15px] leading-relaxed text-white/85 [&_strong]:font-semibold [&_strong]:text-white";

export default function TermsOfServicePage() {
  return (
    <article className={docClass}>
      <header className="space-y-2 border-b border-white/10 pb-8">
        <h1 className="text-3xl font-bold tracking-tight text-white sm:text-4xl">
          Terms of Service
        </h1>
        <p className="text-sm text-white/50">Last updated: May 3, 2026</p>
        <p className="text-sm text-white/60">
          These Terms of Service (“Terms”) govern your access to and use of the TradeICT Earner
          platform, website, and software (collectively, the “Service”) operated by TradeICT
          (“we,” “us,” or “our”). By accessing or using the Service, you agree to these Terms.
        </p>
      </header>

      <section className="space-y-4">
        <h2 className="text-xl font-semibold text-white">1. Nature of the Service</h2>
        <p>
          TradeICT Earner is a software-as-a-service (“SaaS”) execution and automation tool. The
          Service is designed to connect to third-party cryptocurrency exchanges or brokers that you
          designate, using application programming interface (“API”) credentials or other
          connection methods that you authorize. The Service may facilitate algorithmic or
          copy-trading-style execution and related features as described in our product materials.
        </p>
        <p>
          <strong>Non-custodial.</strong> We do not hold, custody, or control your trading funds or
          digital assets. Balances remain with your exchange or broker subject to their terms. Our
          role is limited to providing software that communicates with accounts you control via API,
          in accordance with your instructions and strategy subscriptions.
        </p>
      </section>

      <section className="space-y-4">
        <h2 className="text-xl font-semibold text-white">2. Eligibility and accounts</h2>
        <p>
          You must be legally able to enter a binding contract in your jurisdiction and comply with
          all applicable laws, including those relating to trading, securities, derivatives,
          anti-money laundering, sanctions, and tax. You are responsible for maintaining the
          confidentiality of your account credentials and for all activity under your account.
        </p>
      </section>

      <section className="space-y-4">
        <h2 className="text-xl font-semibold text-white">3. API access and authorization</h2>
        <p>
          You authorize us to access and act on your connected exchange or broker accounts only to
          the extent necessary to provide the Service and as permitted by the permissions you
          grant (for example, trading versus read-only API keys). You represent that you have the
          right to grant such access. You may revoke API keys or disconnect integrations at your
          broker or exchange at any time; doing so may limit or stop Service functionality.
        </p>
      </section>

      <section className="space-y-4">
        <h2 className="text-xl font-semibold text-white">4. Strategies, signals, and automation</h2>
        <p>
          Where the Service allows subscription to strategies or copying of trading behavior, such
          features are tools for execution only. We do not guarantee any strategy’s performance,
          accuracy, or suitability. Past results do not guarantee future performance. You remain
          solely responsible for deciding whether to enable automation, which strategies to follow,
          position sizing, and risk limits.
        </p>
      </section>

      <section className="space-y-4">
        <h2 className="text-xl font-semibold text-white">5. Fees and payment</h2>
        <p>
          Fees for the Service, if any, are as stated at checkout or in your subscription plan. You
          agree to pay all fees when due. Applicable taxes may be additional. We may change fees
          with reasonable notice where required by law.
        </p>
      </section>

      <section className="space-y-4">
        <h2 className="text-xl font-semibold text-white">6. Prohibited uses</h2>
        <p>You agree not to:</p>
        <ul className="list-disc space-y-2 pl-6">
          <li>Violate any law or regulation or infringe others’ rights;</li>
          <li>Use the Service to manipulate markets, engage in wash trading, or other abusive practices;</li>
          <li>Attempt to gain unauthorized access to our systems, other users’ accounts, or exchanges;</li>
          <li>Reverse engineer, scrape, or misuse the Service except as permitted by law;</li>
          <li>Use the Service in any jurisdiction where such use is prohibited.</li>
        </ul>
      </section>

      <section className="space-y-4">
        <h2 className="text-xl font-semibold text-white">7. Intellectual property</h2>
        <p>
          The Service, including software, branding, and documentation, is owned by us or our
          licensors and is protected by intellectual property laws. Subject to these Terms, we grant
          you a limited, non-exclusive, non-transferable license to use the Service for your
          internal purposes. See also our End-User License Agreement.
        </p>
      </section>

      <section className="space-y-4">
        <h2 className="text-xl font-semibold text-white">8. Disclaimers</h2>
        <p>
          THE SERVICE IS PROVIDED “AS IS” AND “AS AVAILABLE.” TO THE MAXIMUM EXTENT PERMITTED BY LAW,
          WE DISCLAIM ALL WARRANTIES, EXPRESS OR IMPLIED, INCLUDING MERCHANTABILITY, FITNESS FOR A
          PARTICULAR PURPOSE, AND NON-INFRINGEMENT. WE DO NOT WARRANT UNINTERRUPTED OR ERROR-FREE
          OPERATION. TRADING INVOLVES SUBSTANTIAL RISK OF LOSS; WE ARE NOT A BROKER, EXCHANGE,
          CUSTODIAN, OR INVESTMENT ADVISOR.
        </p>
      </section>

      <section className="space-y-4">
        <h2 className="text-xl font-semibold text-white">9. Limitation of liability</h2>
        <p>
          TO THE MAXIMUM EXTENT PERMITTED BY LAW, WE AND OUR AFFILIATES, OFFICERS, AND EMPLOYEES WILL
          NOT BE LIABLE FOR ANY INDIRECT, INCIDENTAL, SPECIAL, CONSEQUENTIAL, OR PUNITIVE DAMAGES, OR
          FOR LOSS OF PROFITS, DATA, OR GOODWILL, ARISING FROM YOUR USE OF THE SERVICE OR TRADING
          LOSSES IN YOUR BROKER ACCOUNTS. OUR TOTAL LIABILITY FOR ANY CLAIM ARISING OUT OF THESE
          TERMS OR THE SERVICE WILL NOT EXCEED THE GREATER OF (A) THE AMOUNT YOU PAID US FOR THE
          SERVICE IN THE TWELVE MONTHS BEFORE THE CLAIM OR (B) ONE HUNDRED U.S. DOLLARS, EXCEPT
          WHERE PROHIBITED BY LAW.
        </p>
      </section>

      <section className="space-y-4">
        <h2 className="text-xl font-semibold text-white">10. Indemnity</h2>
        <p>
          You will defend, indemnify, and hold harmless TradeICT and its affiliates from claims,
          damages, and expenses (including reasonable attorneys’ fees) arising from your use of the
          Service, your trading activity, your violation of these Terms, or your violation of
          third-party rights.
        </p>
      </section>

      <section className="space-y-4">
        <h2 className="text-xl font-semibold text-white">11. Suspension and termination</h2>
        <p>
          We may suspend or terminate your access if you breach these Terms, create risk or legal
          exposure, or as required by law. You may stop using the Service at any time. Provisions
          that by their nature should survive will survive termination.
        </p>
      </section>

      <section className="space-y-4">
        <h2 className="text-xl font-semibold text-white">12. Changes</h2>
        <p>
          We may modify these Terms by posting updated Terms and updating the “Last updated” date.
          Material changes may require additional notice where required by law. Continued use after
          changes constitutes acceptance where permitted.
        </p>
      </section>

      <section className="space-y-4">
        <h2 className="text-xl font-semibold text-white">13. Governing law and disputes</h2>
        <p>
          These Terms are governed by the laws applicable as designated in your agreement or, if
          none, by the laws of the jurisdiction in which TradeICT is organized, without regard to
          conflict-of-law rules. Courts or arbitration as specified in a separate agreement may
          apply; if none, you agree to the exclusive jurisdiction of competent courts in that
          jurisdiction, except where consumer mandatory rights apply.
        </p>
      </section>

      <section className="space-y-4">
        <h2 className="text-xl font-semibold text-white">14. Contact</h2>
        <p>
          For questions about these Terms, contact us through the channels provided on the TradeICT
          Earner website.
        </p>
      </section>

      <footer className="border-t border-white/10 pt-8 text-sm text-white/50">
        <p>
          This document is provided for informational purposes and does not constitute legal advice.
          Consult qualified counsel for your situation.
        </p>
      </footer>
    </article>
  );
}
