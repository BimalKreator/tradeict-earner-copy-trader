import type { Metadata } from "next";
import Link from "next/link";
import { LegalPageShell, legalDocClass } from "@/components/legal/LegalPageShell";
import { COMPANY } from "@/lib/company";

export const metadata: Metadata = {
  title: "Pricing",
  description: `Transparent pricing for ${COMPANY.productName} — revenue share and subscriptions.`,
};

export default function PricingPage() {
  return (
    <LegalPageShell>
      <article className={legalDocClass}>
        <header className="space-y-2 border-b border-white/10 pb-8">
          <h1 className="text-3xl font-bold tracking-tight text-white sm:text-4xl">Pricing</h1>
          <p className="text-sm text-white/50">Last updated: May 17, 2026</p>
          <p>
            {COMPANY.legalName} charges for software access and performance-based revenue share.
            All amounts are displayed in your dashboard before you confirm payment via our
            payment gateway (Cashfree or other authorized partners). GST ({COMPANY.gstin}) applies
            where applicable.
          </p>
        </header>

        <section className="space-y-4">
          <h2>1. Revenue share (performance fee)</h2>
          <p>
            When you subscribe to a copy-trading strategy, a <strong>profit share percentage</strong>{" "}
            applies to positive <strong>realized</strong> profit for that strategy each calendar
            month (high-water-mark billing). The exact percentage is shown on each strategy card
            before subscription (typically between 10%–30% depending on the strategy).
          </p>
          <div className="rounded-lg border border-cyan-500/25 bg-cyan-500/10 p-4 text-sm">
            <p className="font-medium text-cyan-100">Example</p>
            <p className="mt-2 text-white/80">
              If a strategy has a 20% revenue share and your realized profit for the month is
              ₹10,000, the invoice amount is ₹2,000 (+ GST). Losses in the month do not generate
              revenue share; only net positive realized PnL in the billing window is considered.
            </p>
          </div>
        </section>

        <section className="space-y-4">
          <h2>2. Strategy subscription / platform fees</h2>
          <p>
            Some strategies may charge a fixed monthly subscription or minimum capital requirement,
            as listed on the strategy detail page. You will see the fee before activating copy
            trading.
          </p>
        </section>

        <section className="space-y-4">
          <h2>3. When charges occur</h2>
          <ul>
            <li>Revenue share invoices are generated monthly from closed trade PnL.</li>
            <li>Payment is due within the period shown on the invoice (typically 5 days).</li>
            <li>
              Unpaid invoices may pause copy trading until settled (see Billing in your dashboard).
            </li>
          </ul>
        </section>

        <section className="space-y-4">
          <h2>4. Exchange &amp; network costs</h2>
          <p>
            Trading fees, funding, and slippage charged by Delta Exchange or other venues are
            separate and paid directly to the exchange — not to {COMPANY.legalName}.
          </p>
        </section>

        <section className="space-y-4">
          <h2>5. Refunds</h2>
          <p>
            Fees for executed copy-trading services are generally non-refundable. See our{" "}
            <Link href="/refund" className="text-cyan-400 hover:underline">
              Refund &amp; Cancellation Policy
            </Link>
            .
          </p>
        </section>

        <section className="space-y-4">
          <h2>6. Questions</h2>
          <p>
            Contact{" "}
            <a href={`mailto:${COMPANY.supportEmail}`} className="text-cyan-400 hover:underline">
              {COMPANY.supportEmail}
            </a>{" "}
            or visit{" "}
            <Link href="/contact" className="text-cyan-400 hover:underline">
              Contact Us
            </Link>
            .
          </p>
        </section>
      </article>
    </LegalPageShell>
  );
}
