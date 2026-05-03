import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "End-User License Agreement",
  description:
    "EULA for TradeICT Earner automated copy-trading and algorithmic execution software.",
};

const docClass =
  "space-y-6 text-[15px] leading-relaxed text-white/85 [&_strong]:font-semibold [&_strong]:text-white";

export default function EULAPage() {
  return (
    <article className={docClass}>
      <header className="space-y-2 border-b border-white/10 pb-8">
        <h1 className="text-3xl font-bold tracking-tight text-white sm:text-4xl">
          End-User License Agreement
        </h1>
        <p className="text-sm text-white/50">Last updated: May 3, 2026</p>
        <p className="text-sm text-white/60">
          This End-User License Agreement (“EULA”) is a legal agreement between you (“you” or
          “your”) and TradeICT (“we,” “us,” or “our”) for the TradeICT Earner software, including
          web applications, downloadable clients if offered, updates, and documentation (collectively,
          the “Software”). The Software is a SaaS execution tool that connects to your exchange or
          broker accounts via API for algorithmic and copy-trading-style automation.{" "}
          <strong>The Software is non-custodial:</strong> we do not hold your trading funds.
        </p>
      </header>

      <section className="space-y-4">
        <h2 className="text-xl font-semibold text-white">1. License grant</h2>
        <p>
          Subject to this EULA and your payment of applicable fees, we grant you a personal or
          organizational, limited, non-exclusive, non-transferable, non-sublicensable, revocable
          license to access and use the Software solely to automate and manage trading execution on
          accounts you lawfully control, in accordance with our Terms of Service and documentation.
        </p>
      </section>

      <section className="space-y-4">
        <h2 className="text-xl font-semibold text-white">2. Restrictions</h2>
        <p>You must not, and must not permit others to:</p>
        <ul className="list-disc space-y-2 pl-6">
          <li>Copy, modify, adapt, translate, or create derivative works of the Software, except as allowed by applicable law;</li>
          <li>Reverse engineer, decompile, disassemble, or attempt to derive source code, except where prohibited by law;</li>
          <li>Rent, lease, lend, sell, sublicense, distribute, or host the Software for third parties;</li>
          <li>Remove or alter proprietary notices;</li>
          <li>Use the Software to violate law, exchange rules, or third-party rights;</li>
          <li>Circumvent technical limits, usage quotas, or security controls;</li>
          <li>Use the Software to interfere with or disrupt exchanges, networks, or other users.</li>
        </ul>
      </section>

      <section className="space-y-4">
        <h2 className="text-xl font-semibold text-white">3. API connectivity</h2>
        <p>
          The Software operates by sending instructions to third-party venues using credentials you
          supply. You are responsible for key scope, rotation, and revocation. We are not responsible
          for exchange downtime, API changes, rate limits, or erroneous venue behavior.
        </p>
      </section>

      <section className="space-y-4">
        <h2 className="text-xl font-semibold text-white">4. Third-party materials</h2>
        <p>
          The Software may interoperate with exchanges, data feeds, or strategy content from third
          parties. Such materials are governed by third-party terms. We disclaim responsibility for
          third-party services except as required by law.
        </p>
      </section>

      <section className="space-y-4">
        <h2 className="text-xl font-semibold text-white">5. Updates</h2>
        <p>
          We may provide updates, patches, or new versions. Updates may be mandatory for security
          or operational reasons. Continued use after update constitutes acceptance of the updated
          Software to the extent integrated with this EULA.
        </p>
      </section>

      <section className="space-y-4">
        <h2 className="text-xl font-semibold text-white">6. Ownership</h2>
        <p>
          We and our licensors retain all rights, title, and interest in the Software and related
          intellectual property. Except for the limited license granted above, no rights are granted
          by implication or estoppel.
        </p>
      </section>

      <section className="space-y-4">
        <h2 className="text-xl font-semibold text-white">7. Open source</h2>
        <p>
          If any component is distributed under an open-source license, that component is governed
          by its license terms; this EULA does not restrict your rights under such licenses for those
          components.
        </p>
      </section>

      <section className="space-y-4">
        <h2 className="text-xl font-semibold text-white">8. Disclaimer of warranties</h2>
        <p>
          TO THE MAXIMUM EXTENT PERMITTED BY LAW, THE SOFTWARE IS PROVIDED “AS IS” WITHOUT WARRANTY
          OF ANY KIND. WE DISCLAIM ALL WARRANTIES, EXPRESS OR IMPLIED, INCLUDING MERCHANTABILITY,
          FITNESS FOR A PARTICULAR PURPOSE, ACCURACY, QUIET ENJOYMENT, AND NON-INFRINGEMENT. WE DO
          NOT WARRANT THAT THE SOFTWARE WILL BE UNINTERRUPTED, ERROR-FREE, OR FREE OF HARMFUL
          COMPONENTS.
        </p>
      </section>

      <section className="space-y-4">
        <h2 className="text-xl font-semibold text-white">9. Limitation of liability</h2>
        <p>
          TO THE MAXIMUM EXTENT PERMITTED BY LAW, IN NO EVENT WILL WE BE LIABLE FOR INDIRECT,
          INCIDENTAL, SPECIAL, CONSEQUENTIAL, EXEMPLARY, OR PUNITIVE DAMAGES, OR FOR LOSS OF
          PROFITS, REVENUE, DATA, OR GOODWILL, ARISING FROM THIS EULA OR THE SOFTWARE, INCLUDING
          TRADING LOSSES IN YOUR ACCOUNTS. OUR TOTAL LIABILITY FOR ANY CLAIM WILL NOT EXCEED THE
          FEES YOU PAID FOR THE SOFTWARE IN THE TWELVE MONTHS BEFORE THE CLAIM (OR ONE HUNDRED U.S.
          DOLLARS IF NO FEES WERE PAID), EXCEPT WHERE LIABILITY CANNOT BE LIMITED BY LAW.
        </p>
      </section>

      <section className="space-y-4">
        <h2 className="text-xl font-semibold text-white">10. Indemnity</h2>
        <p>
          You will indemnify and hold harmless TradeICT and its affiliates from claims arising from
          your use of the Software, your trading activity, or your breach of this EULA.
        </p>
      </section>

      <section className="space-y-4">
        <h2 className="text-xl font-semibold text-white">11. Termination</h2>
        <p>
          Your license ends when your subscription ends, when we suspend or terminate access under our
          Terms of Service, or if you breach this EULA. Upon termination, you must cease use of the
          Software and delete local copies we permit you to hold, if any. Sections intended to
          survive will survive.
        </p>
      </section>

      <section className="space-y-4">
        <h2 className="text-xl font-semibold text-white">12. Export and sanctions</h2>
        <p>
          You represent that you are not prohibited from using the Software under applicable export
          control or sanctions laws. You will not use or export the Software in violation of such
          laws.
        </p>
      </section>

      <section className="space-y-4">
        <h2 className="text-xl font-semibold text-white">13. General</h2>
        <p>
          This EULA, together with our Terms of Service and policies referenced therein, is the
          entire agreement regarding the Software license. If a provision is unenforceable, the
          remainder remains in effect. Failure to enforce a provision is not a waiver.
        </p>
      </section>

      <section className="space-y-4">
        <h2 className="text-xl font-semibold text-white">14. Contact</h2>
        <p>
          Questions regarding this EULA may be directed to the contact information on the TradeICT
          Earner website.
        </p>
      </section>

      <footer className="border-t border-white/10 pt-8 text-sm text-white/50">
        <p>
          This EULA is a legal document; consult qualified counsel if you have questions about your
          rights or obligations.
        </p>
      </footer>
    </article>
  );
}
