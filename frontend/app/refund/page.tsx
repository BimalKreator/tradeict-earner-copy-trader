import type { Metadata } from "next";
import { LegalPageShell, legalDocClass } from "@/components/legal/LegalPageShell";
import { COMPANY } from "@/lib/company";

export const metadata: Metadata = {
  title: "Refund & Cancellation Policy",
  description: `Refund and cancellation terms for ${COMPANY.productName}.`,
};

export default function RefundPage() {
  return (
    <LegalPageShell>
      <article className={legalDocClass}>
        <header className="space-y-2 border-b border-white/10 pb-8">
          <h1 className="text-3xl font-bold tracking-tight text-white sm:text-4xl">
            Refund &amp; Cancellation Policy
          </h1>
          <p className="text-sm text-white/50">Last updated: May 17, 2026</p>
          <p>
            This policy applies to fees paid to <strong>{COMPANY.legalName}</strong> for{" "}
            {COMPANY.productName}, including strategy subscriptions, platform fees, and revenue
            share settlements collected via our payment gateway.
          </p>
        </header>

        <section className="space-y-4">
          <h2>1. General principle</h2>
          <p>
            <strong>
              Software service fees and revenue shares are strictly non-refundable once trades have
              been executed successfully
            </strong>{" "}
            and the Service has been delivered for the applicable billing period. Digital
            execution services are consumed in real time; we cannot reverse market outcomes or
            exchange fills.
          </p>
        </section>

        <section className="space-y-4">
          <h2>2. Revenue share invoices</h2>
          <ul>
            <li>
              Revenue share is charged on positive <strong>realized</strong> profit for a strategy
              in the invoice period, as shown in your dashboard.
            </li>
            <li>
              If you dispute an invoice amount, contact us within <strong>7 calendar days</strong>{" "}
              of issuance with trade logs; we will review calculation errors only.
            </li>
            <li>
              No refund is provided for trading losses, market movement, or voluntary closure of
              positions after copy execution.
            </li>
          </ul>
        </section>

        <section className="space-y-4">
          <h2>3. Subscription / platform fees</h2>
          <ul>
            <li>
              Prepaid subscription fees are non-refundable after the subscription period has
              started and API/copy features have been enabled.
            </li>
            <li>
              If you were charged in error (duplicate payment, wrong amount), contact{" "}
              {COMPANY.supportEmail} within 48 hours with payment proof for a refund to the
              original payment method.
            </li>
            <li>
              Partial-month refunds are not offered unless required by applicable consumer law.
            </li>
          </ul>
        </section>

        <section className="space-y-4">
          <h2>4. When refunds may be considered</h2>
          <ul>
            <li>Duplicate charge verified by our payment partner.</li>
            <li>Service not provisioned due to a confirmed technical fault on our side.</li>
            <li>Chargeback or court order requiring reversal under Indian law.</li>
          </ul>
          <p>Approved refunds are processed within 7–14 business days to the source account.</p>
        </section>

        <section className="space-y-4">
          <h2>5. Cancellation steps</h2>
          <ol>
            <li>Log in to your dashboard at {COMPANY.domain.replace(/^https?:\/\//, "")}.</li>
            <li>Pause or cancel strategy subscriptions under Strategies.</li>
            <li>Revoke or delete API keys on your exchange and in Settings.</li>
            <li>Pay any outstanding invoices under Billing to avoid account suspension.</li>
            <li>
              Email {COMPANY.supportEmail} with subject &quot;Account cancellation&quot; and your
              registered email for confirmation.
            </li>
          </ol>
          <p>
            Cancellation stops future billing but does not erase obligations for amounts already
            due for executed services.
          </p>
        </section>

        <section className="space-y-4">
          <h2>6. Chargebacks</h2>
          <p>
            Filing an unjustified chargeback may result in permanent account termination and
            recovery action for amounts owed.
          </p>
        </section>

        <section className="space-y-4">
          <h2>7. Contact</h2>
          <p>
            {COMPANY.legalName} · {COMPANY.address}
            <br />
            Email:{" "}
            <a href={`mailto:${COMPANY.supportEmail}`} className="text-cyan-400 hover:underline">
              {COMPANY.supportEmail}
            </a>{" "}
            · Phone:{" "}
            <a href={`tel:${COMPANY.supportPhoneTel}`} className="text-cyan-400 hover:underline">
              {COMPANY.supportPhone}
            </a>
          </p>
        </section>
      </article>
    </LegalPageShell>
  );
}
