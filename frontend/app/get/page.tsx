import Link from "next/link";
import { BrandLogo } from "@/components/BrandLogo";
import { LegalPageShell } from "@/components/legal/LegalPageShell";
import { COMPANY } from "@/lib/company";
import { InstallDirectButton } from "./InstallDirectButton";
import { Share2, Smartphone } from "lucide-react";

const iphoneSteps = [
  "Open this page in Safari",
  "Tap the Share button",
  'Tap "Add to Home Screen"',
] as const;

export default function GetInstallPage() {
  return (
    <LegalPageShell>
      <div className="mx-auto flex max-w-lg flex-col gap-8 pb-4">
        <header className="space-y-5 text-center">
          <div className="flex justify-center">
            <BrandLogo href="/" variant="header" priority />
          </div>
          <div className="space-y-2">
            <h1 className="text-2xl font-bold tracking-tight text-white sm:text-3xl">
              {COMPANY.productName}
            </h1>
            <p className="text-base leading-relaxed text-white/75 sm:text-lg">
              Install TradeICT Earner on your phone
            </p>
          </div>
        </header>

        <section className="space-y-4 rounded-2xl border border-white/10 bg-slate-900/50 p-5 sm:p-6">
          <div className="flex items-center gap-3">
            <div className="rounded-xl border border-emerald-500/30 bg-emerald-500/10 p-2.5 text-emerald-300">
              <Smartphone className="h-5 w-5" aria-hidden />
            </div>
            <h2 className="text-lg font-semibold text-white">Android</h2>
          </div>

          <div className="space-y-4">
            {COMPANY.PLAY_STORE_LIVE ? (
              <>
                <a
                  href={COMPANY.PLAY_STORE_URL}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex w-full items-center justify-center rounded-xl bg-white px-5 py-3.5 text-sm font-semibold text-slate-900 transition hover:bg-white/90"
                >
                  Get it on Google Play
                </a>

                <div className="space-y-3 border-t border-white/10 pt-4">
                  <p className="text-sm text-white/60">
                    Or install directly from your browser
                  </p>
                  <InstallDirectButton />
                </div>
              </>
            ) : (
              <>
                <p className="text-sm leading-relaxed text-white/70">
                  Install directly from your browser — no download required.
                </p>
                <InstallDirectButton />
              </>
            )}
          </div>
        </section>

        <section className="space-y-4 rounded-2xl border border-white/10 bg-slate-900/50 p-5 sm:p-6">
          <div className="flex items-center gap-3">
            <div className="rounded-xl border border-sky-500/30 bg-sky-500/10 p-2.5 text-sky-300">
              <Share2 className="h-5 w-5" aria-hidden />
            </div>
            <h2 className="text-lg font-semibold text-white">iPhone</h2>
          </div>

          <ol className="space-y-3">
            {iphoneSteps.map((step, index) => (
              <li key={step} className="flex gap-3 text-sm leading-relaxed text-white/80">
                <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-white/10 text-xs font-semibold text-white">
                  {index + 1}
                </span>
                <span className="pt-0.5">{step}</span>
              </li>
            ))}
          </ol>
        </section>

        <p className="text-center text-xs leading-relaxed text-white/45">
          Works on any phone browser. No download required.
        </p>

        <p className="text-center text-sm text-white/50">
          Already have an account?{" "}
          <Link href="/login" className="text-cyan-400 hover:underline">
            Sign in
          </Link>
        </p>
      </div>
    </LegalPageShell>
  );
}
