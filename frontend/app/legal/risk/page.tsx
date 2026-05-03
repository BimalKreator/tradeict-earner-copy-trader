import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Risk Disclaimer",
  description:
    "Risk disclosure for cryptocurrency and algorithmic copy trading via TradeICT Earner.",
};

const docClass =
  "space-y-6 text-[15px] leading-relaxed text-white/85 [&_strong]:font-semibold [&_strong]:text-white";

export default function RiskDisclaimerPage() {
  return (
    <article className={docClass}>
      <header className="space-y-2 border-b border-white/10 pb-8">
        <h1 className="text-3xl font-bold tracking-tight text-white sm:text-4xl">
          Risk Disclaimer
        </h1>
        <p className="text-sm text-white/50">Last updated: May 3, 2026</p>
        <p className="rounded-xl border border-amber-500/50 bg-amber-500/10 p-4 text-sm text-amber-50">
          <strong className="text-amber-200">HIGH RISK.</strong> Trading cryptocurrencies and using
          automated or algorithmic execution—including copy trading—is extremely risky. You may lose
          all capital you allocate to trading. Read this entire disclaimer carefully before using
          TradeICT Earner.
        </p>
      </header>

      <section className="space-y-4">
        <h2 className="text-xl font-semibold text-white">1. Not investment advice</h2>
        <p>
          TradeICT Earner is a software-as-a-service execution tool. We are not a registered
          investment adviser, broker-dealer, exchange, or custodian in any jurisdiction unless
          expressly stated otherwise in writing. Nothing on our platform constitutes financial,
          investment, legal, or tax advice. You alone are responsible for evaluating whether any
          trading activity is suitable for you.
        </p>
      </section>

      <section className="space-y-4">
        <h2 className="text-xl font-semibold text-white">2. Non-custodial platform</h2>
        <p>
          <strong>We do not hold your trading funds.</strong> TradeICT Earner connects to your
          exchange or broker accounts via API. Your assets remain under the custody and terms of
          those third parties. You maintain full control of API permissions and should use
          least-privilege keys where supported. You bear all risk of loss in those accounts.
        </p>
      </section>

      <section className="space-y-4">
        <h2 className="text-xl font-semibold text-white">3. Crypto and derivative risks</h2>
        <p>
          Digital assets are volatile, illiquid in stressed markets, subject to regulatory change,
          technological failure (including blockchain forks and smart-contract bugs), exchange
          insolvency, cyberattacks, and operational errors. Leverage, margin, futures, and other
          derivatives can amplify losses beyond your initial deposit. Fees, slippage, funding rates,
          and liquidity conditions may materially affect outcomes.
        </p>
      </section>

      <section className="space-y-4">
        <h2 className="text-xl font-semibold text-white">4. Algorithmic and copy-trading risks</h2>
        <p>
          Automated strategies—including those labeled “copy” or “mirror” trading—execute orders
          according to rules, signals, or third-party behavior you enable. Risks include but are not
          limited to:
        </p>
        <ul className="list-disc space-y-2 pl-6">
          <li>
            <strong>Execution errors:</strong> bugs, latency, connectivity loss, exchange API
            outages, or partial fills;
          </li>
          <li>
            <strong>Model and signal risk:</strong> strategies may fail in new market regimes;
            historical performance is not indicative of future results;
          </li>
          <li>
            <strong>Discrepancies:</strong> your results may differ from a “master” account due to
            sizing, timing, fees, account tier, or instrument availability;
          </li>
          <li>
            <strong>Over-concentration:</strong> automation can compound losses rapidly if risk
            limits are absent or misconfigured.
          </li>
        </ul>
      </section>

      <section className="space-y-4">
        <h2 className="text-xl font-semibold text-white">5. Past performance</h2>
        <p>
          Any illustrated or reported performance (including backtests, leaderboards, or strategy
          statistics) may be hypothetical, incomplete, or unaudited. Past performance—whether of the
          software, a strategy provider, or other users—is not a guarantee of future results.
        </p>
      </section>

      <section className="space-y-4">
        <h2 className="text-xl font-semibold text-white">6. Regulatory and tax considerations</h2>
        <p>
          Laws governing crypto trading vary by country and change frequently. You are responsible
          for compliance with applicable regulations and for reporting and paying taxes as required
          in your jurisdiction.
        </p>
      </section>

      <section className="space-y-4">
        <h2 className="text-xl font-semibold text-white">7. No guarantees</h2>
        <p>
          We do not guarantee profit, loss avoidance, or uninterrupted Service. Software may
          contain defects. Third-party exchanges may restrict or reverse activity. You accept all
          risks associated with use of the Service and trading in your own accounts.
        </p>
      </section>

      <section className="space-y-4">
        <h2 className="text-xl font-semibold text-white">8. Acknowledgment</h2>
        <p>
          By using TradeICT Earner, you acknowledge that you have read and understood this Risk
          Disclaimer, that you may lose your entire investment, and that you trade voluntarily and
          at your own risk.
        </p>
      </section>

      <footer className="border-t border-white/10 pt-8 text-sm text-white/50">
        <p>
          This Risk Disclaimer does not list every possible risk. Seek independent professional
          advice if you are unsure whether trading or automation is appropriate for you.
        </p>
      </footer>
    </article>
  );
}
