import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Cookies Policy",
  description:
    "Cookie and similar technology usage for TradeICT Earner’s SaaS platform and website.",
};

const docClass =
  "space-y-6 text-[15px] leading-relaxed text-white/85 [&_strong]:font-semibold [&_strong]:text-white";

export default function CookiesPolicyPage() {
  return (
    <article className={docClass}>
      <header className="space-y-2 border-b border-white/10 pb-8">
        <h1 className="text-3xl font-bold tracking-tight text-white sm:text-4xl">Cookies Policy</h1>
        <p className="text-sm text-white/50">Last updated: May 3, 2026</p>
        <p className="text-sm text-white/60">
          This Cookies Policy explains how TradeICT (“we,” “us,” or “our”) uses cookies and similar
          technologies when you visit or use the TradeICT Earner website and SaaS applications
          (the “Service”). TradeICT Earner is a non-custodial execution platform that connects to
          your exchange accounts via API; we do not hold your trading funds.
        </p>
      </header>

      <section className="space-y-4">
        <h2 className="text-xl font-semibold text-white">1. What are cookies?</h2>
        <p>
          Cookies are small text files stored on your device when you visit a website. Similar
          technologies include local storage, session storage, pixels, and scripts that collect or
          store information on your device. Together we refer to these as “cookies” unless a
          specific technology is named.
        </p>
      </section>

      <section className="space-y-4">
        <h2 className="text-xl font-semibold text-white">2. How we use cookies</h2>
        <p>We use cookies and similar technologies to:</p>
        <ul className="list-disc space-y-2 pl-6">
          <li>
            <strong>Strictly necessary:</strong> enable core functionality such as security,
            authentication, session continuity, load balancing, and fraud prevention;
          </li>
          <li>
            <strong>Preferences:</strong> remember settings such as language or UI preferences;
          </li>
          <li>
            <strong>Analytics:</strong> understand how the Service is used in aggregate to improve
            performance and reliability;
          </li>
          <li>
            <strong>Product diagnostics:</strong> identify errors and stability issues in our SaaS
            applications.
          </li>
        </ul>
      </section>

      <section className="space-y-4">
        <h2 className="text-xl font-semibold text-white">3. First-party and third-party cookies</h2>
        <p>
          We set first-party cookies directly. We may allow third-party providers (e.g., analytics or
          infrastructure partners) to set cookies subject to their policies. Those providers may
          process data according to their own privacy notices.
        </p>
      </section>

      <section className="space-y-4">
        <h2 className="text-xl font-semibold text-white">4. Session and persistent cookies</h2>
        <p>
          Session cookies expire when you close your browser. Persistent cookies remain for a set
          period or until you delete them. Retention periods vary by cookie purpose.
        </p>
      </section>

      <section className="space-y-4">
        <h2 className="text-xl font-semibold text-white">5. Your choices</h2>
        <p>
          Most browsers let you refuse or delete cookies through settings. Blocking strictly
          necessary cookies may impair login, security features, or core functionality. Where
          required by law, we will obtain consent before using non-essential cookies and provide a
          mechanism to withdraw consent.
        </p>
        <p>
          You may also use industry opt-out tools for certain interest-based advertising where
          applicable; our Service is primarily a trading execution tool, so advertising cookies may
          be limited.
        </p>
      </section>

      <section className="space-y-4">
        <h2 className="text-xl font-semibold text-white">6. Do Not Track</h2>
        <p>
          There is no uniform standard for “Do Not Track” signals. We process personal data as
          described in our Privacy Policy regardless of DNT unless otherwise required by applicable
          law.
        </p>
      </section>

      <section className="space-y-4">
        <h2 className="text-xl font-semibold text-white">7. Updates</h2>
        <p>
          We may update this Cookies Policy to reflect changes in technology or law. Check the “Last
          updated” date and review the Privacy Policy for broader data practices.
        </p>
      </section>

      <section className="space-y-4">
        <h2 className="text-xl font-semibold text-white">8. Contact</h2>
        <p>
          Questions about this Cookies Policy may be directed to the contact information on the
          TradeICT Earner website.
        </p>
      </section>

      <footer className="border-t border-white/10 pt-8 text-sm text-white/50">
        <p>
          This policy is for informational purposes and does not constitute legal advice.
        </p>
      </footer>
    </article>
  );
}
