import type { Metadata } from "next";
import Link from "next/link";
import { LegalPageShell, legalDocClass } from "@/components/legal/LegalPageShell";
import { COMPANY } from "@/lib/company";

const APP_NAME = "Tradeict AI Earner";

export const metadata: Metadata = {
  title: "Delete Account & Data",
  description: `How to request account and data deletion for ${APP_NAME}.`,
};

export default function DeleteAccountPage() {
  return (
    <LegalPageShell>
      <article className={legalDocClass}>
        <header className="space-y-2 border-b border-white/10 pb-8">
          <h1 className="text-3xl font-bold tracking-tight text-white sm:text-4xl">
            Account &amp; Data Deletion
          </h1>
          <p className="text-sm text-white/50">Last updated: July 9, 2026</p>
          <p>
            This page explains how users of <strong>{APP_NAME}</strong> (operated by{" "}
            {COMPANY.legalName}) can request deletion of their account and associated personal
            data.
          </p>
        </header>

        <section className="space-y-4">
          <h2>How to request deletion</h2>
          <p>To request account and data deletion, you may use either of the following methods:</p>
          <ol>
            <li>
              <strong>Email support:</strong> Send an email to{" "}
              <a
                href={`mailto:${COMPANY.supportEmail}?subject=Account%20Deletion%20Request`}
                className="text-cyan-400 hover:underline"
              >
                {COMPANY.supportEmail}
              </a>{" "}
              from your <strong>registered email address</strong>. Include your full name and a
              clear statement that you want your account and personal data deleted.
            </li>
            <li>
              <strong>In-app:</strong> Sign in, open <strong>Settings</strong> in the dashboard,
              and use the account deletion option if available, or contact support from the same
              screen.
            </li>
          </ol>
          <p>
            We may ask you to verify your identity before processing the request to protect your
            account from unauthorized deletion.
          </p>
        </section>

        <section className="space-y-4">
          <h2>What we delete</h2>
          <p>Upon a verified deletion request, we permanently delete or anonymize:</p>
          <ul>
            <li>Your account email and login credentials</li>
            <li>Personal profile information (name, mobile, KYC fields you provided)</li>
            <li>Delta Exchange API keys and linked exchange credentials stored for copy trading</li>
            <li>Active strategy subscriptions and deployment settings tied to your account</li>
          </ul>
        </section>

        <section className="space-y-4">
          <h2>Data we retain</h2>
          <p>
            Upon request, your email, Delta API keys, and personal profile will be permanently
            deleted. <strong>Financial transaction history and audit logs are retained for legal
            compliance</strong> (tax, anti-fraud, payment disputes, and regulatory obligations) for
            the period required by applicable law, after which they are deleted or anonymized.
          </p>
        </section>

        <section className="space-y-4">
          <h2>Processing time</h2>
          <p>
            We aim to complete verified deletion requests within <strong>30 days</strong>. You will
            receive a confirmation email once processing is complete.
          </p>
        </section>

        <section className="space-y-4">
          <h2>Questions</h2>
          <p>
            For privacy or deletion questions, contact{" "}
            <a href={`mailto:${COMPANY.supportEmail}`} className="text-cyan-400 hover:underline">
              {COMPANY.supportEmail}
            </a>{" "}
            or visit our{" "}
            <Link href="/privacy" className="text-cyan-400 hover:underline">
              Privacy Policy
            </Link>
            .
          </p>
        </section>
      </article>
    </LegalPageShell>
  );
}
