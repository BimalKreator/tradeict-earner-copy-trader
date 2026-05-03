import Link from "next/link";

const steps = [
  { n: 1, title: "Register with TradeICT", body: "Create your account and verify your email in minutes." },
  { n: 2, title: "Link your broker (via API)", body: "Connect securely using your broker’s API keys — your credentials stay with you." },
  { n: 3, title: "Subscribe to a strategy", body: "Browse proven strategies and pick one that matches your risk profile." },
  { n: 4, title: "Start copying trades automatically", body: "Trades sync in real time while you keep full custody of your funds." },
] as const;

const footerLinks = [
  { href: "/legal/terms", label: "Terms of Service" },
  { href: "/legal/privacy", label: "Privacy Policy" },
  { href: "/legal/cookies", label: "Cookies Policy" },
  { href: "/legal/risk", label: "Risk Disclaimer" },
  { href: "/legal/conflict", label: "Conflict of Interest Policy" },
  { href: "/legal/consent", label: "Declaration of Consent" },
  { href: "/legal/eula", label: "End-User License Agreement" },
] as const;

export default function Home() {
  return (
    <div className="flex min-h-full flex-col">
      <header className="glass-nav sticky top-0 z-50">
        <nav className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-4 py-4 sm:px-6 lg:px-8">
          <Link
            href="/"
            className="text-lg font-semibold tracking-tight text-white transition hover:text-primary"
          >
            <span className="text-primary">TradeICT</span> Earner
          </Link>
          <div className="flex shrink-0 items-center gap-2 sm:gap-3">
            <Link
              href="/login"
              className="rounded-lg border border-glassBorder bg-white/[0.04] px-3 py-2 text-sm font-medium text-white/90 transition hover:bg-white/10 sm:px-4"
            >
              Sign In
            </Link>
            <Link
              href="/signup"
              className="rounded-lg bg-primary px-3 py-2 text-sm font-semibold text-white shadow-lg shadow-primary/25 transition hover:bg-primary/90 sm:px-4"
            >
              Sign Up
            </Link>
          </div>
        </nav>
      </header>

      <main className="flex-1">
        <section className="relative overflow-hidden px-4 pb-20 pt-12 sm:px-6 sm:pb-28 sm:pt-16 lg:px-8">
          <div className="pointer-events-none absolute inset-0 -z-10 bg-[radial-gradient(ellipse_80%_50%_at_50%_-20%,rgba(10,132,255,0.22),transparent)]" />
          <div className="mx-auto max-w-4xl text-center">
            <p className="mb-4 text-xs font-medium uppercase tracking-[0.2em] text-primary">
              Copy trading · Your keys · Your funds
            </p>
            <h1 className="text-balance text-3xl font-bold leading-tight tracking-tight text-white sm:text-4xl lg:text-5xl">
              Tradeict Earner brings CopyTrading to your fingertips! Copy the actions of proven strategies and begin your trading journey.
            </h1>
            <p className="mx-auto mt-6 max-w-2xl text-pretty text-lg text-white/75 sm:text-xl">
              No need to give your money to anyone else. Keep full control of your funds.
            </p>
            <div className="mt-10 flex flex-col items-center justify-center gap-3 sm:flex-row">
              <Link
                href="/login"
                className="inline-flex w-full max-w-xs items-center justify-center rounded-xl bg-primary px-8 py-3.5 text-base font-semibold text-white shadow-xl shadow-primary/30 transition hover:bg-primary/90 sm:w-auto"
              >
                Get started
              </Link>
              <Link
                href="/login"
                className="inline-flex w-full max-w-xs items-center justify-center rounded-xl border border-glassBorder bg-white/[0.06] px-8 py-3.5 text-base font-medium text-white transition hover:bg-white/10 sm:w-auto"
              >
                Sign in to dashboard
              </Link>
            </div>
          </div>
        </section>

        <section className="border-t border-white/[0.06] px-4 py-16 sm:px-6 lg:px-8">
          <div className="mx-auto max-w-6xl">
            <div className="mb-12 text-center">
              <h2 className="text-2xl font-bold text-white sm:text-3xl">How it works</h2>
              <p className="mt-2 text-white/60">Four steps from signup to automated copy trading.</p>
            </div>
            <ol className="grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
              {steps.map(({ n, title, body }) => (
                <li key={n}>
                  <div className="glass-card flex h-full flex-col p-6">
                    <span className="mb-4 inline-flex h-10 w-10 items-center justify-center rounded-xl bg-primary/20 text-sm font-bold text-primary ring-1 ring-primary/40">
                      {n}
                    </span>
                    <h3 className="text-lg font-semibold text-white">{title}</h3>
                    <p className="mt-2 text-sm leading-relaxed text-white/65">{body}</p>
                  </div>
                </li>
              ))}
            </ol>
          </div>
        </section>

        <section className="border-t border-white/[0.06] px-4 py-16 sm:px-6 lg:px-8">
          <div className="mx-auto max-w-3xl text-center">
            <h2 className="text-2xl font-bold text-white sm:text-3xl">Download the app</h2>
            <p className="mt-3 text-lg text-white/70">
              Now available on Google Play Store and Apple App Store
            </p>
            <div className="mt-8 flex flex-col items-center justify-center gap-4 sm:flex-row sm:gap-6">
              <button
                type="button"
                disabled
                className="flex w-full max-w-[260px] cursor-not-allowed items-center justify-center gap-3 rounded-xl border border-white/10 bg-white/[0.06] px-6 py-4 text-left opacity-80 transition sm:w-auto"
                aria-label="Google Play Store (coming soon)"
              >
                <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-white/10 text-xl font-bold text-white">
                  ▶
                </span>
                <span>
                  <span className="block text-[10px] uppercase tracking-wider text-white/50">Get it on</span>
                  <span className="block text-base font-semibold text-white">Google Play</span>
                </span>
              </button>
              <button
                type="button"
                disabled
                className="flex w-full max-w-[260px] cursor-not-allowed items-center justify-center gap-3 rounded-xl border border-white/10 bg-white/[0.06] px-6 py-4 text-left opacity-80 transition sm:w-auto"
                aria-label="Apple App Store (coming soon)"
              >
                <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-white/10 text-2xl">
                  ⌂
                </span>
                <span>
                  <span className="block text-[10px] uppercase tracking-wider text-white/50">Download on the</span>
                  <span className="block text-base font-semibold text-white">App Store</span>
                </span>
              </button>
            </div>
            <p className="mt-6 text-sm text-white/45">Store links will be enabled when the apps are published.</p>
          </div>
        </section>

        <section className="border-t border-white/[0.06] px-4 py-12 sm:px-6 lg:px-8">
          <div className="mx-auto max-w-4xl">
            <div className="rounded-2xl border-2 border-amber-500/60 bg-amber-500/[0.08] p-6 shadow-[0_0_40px_-8px_rgba(245,158,11,0.35)] sm:p-8">
              <p className="text-center text-[11px] font-bold uppercase tracking-[0.15em] text-amber-400 sm:text-xs">
                Important notice
              </p>
              <p className="mt-4 text-sm leading-relaxed text-amber-50/95 sm:text-base">
                <span className="font-semibold text-amber-200">DISCLAIMER:</span> Trading cryptocurrencies involves significant risk and can result in the loss of your capital. You should not invest more than you can afford to lose. TradeICT Earner provides automated execution software; we are not financial advisors. Past performance of any trading system or methodology is not necessarily indicative of future results.
              </p>
            </div>
          </div>
        </section>
      </main>

      <footer className="mt-auto border-t border-white/[0.08] bg-black/40 px-4 py-12 sm:px-6 lg:px-8">
        <div className="mx-auto max-w-6xl">
          <div className="flex flex-col items-center justify-between gap-8 sm:flex-row sm:items-start">
            <div>
              <p className="text-lg font-semibold text-white">
                <span className="text-primary">TradeICT</span> Earner
              </p>
              <p className="mt-1 max-w-xs text-sm text-white/50">
                Copy trading with custody where it belongs — with you.
              </p>
            </div>
            <nav aria-label="Legal" className="w-full sm:w-auto">
              <ul className="grid grid-cols-1 gap-x-8 gap-y-2 text-center sm:grid-cols-2 sm:text-left lg:grid-cols-1">
                {footerLinks.map(({ href, label }) => (
                  <li key={href}>
                    <Link
                      href={href}
                      className="text-sm text-white/65 underline-offset-2 transition hover:text-primary hover:underline"
                    >
                      {label}
                    </Link>
                  </li>
                ))}
              </ul>
            </nav>
          </div>
          <p className="mt-10 text-center text-xs text-white/35">
            © {new Date().getFullYear()} TradeICT Earner. All rights reserved.
          </p>
        </div>
      </footer>
    </div>
  );
}
