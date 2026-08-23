"use client";

import Link from "next/link";

type RouteErrorViewProps = {
  error: Error & { digest?: string };
  reset: () => void;
  dashboardHref?: string;
};

export function RouteErrorView({
  error,
  reset,
  dashboardHref = "/dashboard",
}: RouteErrorViewProps) {
  return (
    <div className="flex min-h-[50vh] flex-col items-center justify-center px-4 py-16 text-center">
      <div className="w-full max-w-md rounded-2xl border border-slate-800 bg-slate-900/90 p-8 shadow-xl">
        <h1 className="text-xl font-semibold text-white">Kuch galat ho gaya</h1>
        <p className="mt-3 text-sm leading-relaxed text-slate-400">
          Page load karte waqt koi unexpected error aaya. Dobara try karein ya
          dashboard par wapas jayein.
        </p>
        <div className="mt-6 flex flex-col gap-3 sm:flex-row sm:justify-center">
          <button
            type="button"
            onClick={() => reset()}
            className="rounded-lg bg-primary px-5 py-2.5 text-sm font-medium text-white transition hover:bg-primary/90"
          >
            Retry
          </button>
          <Link
            href={dashboardHref}
            className="rounded-lg border border-slate-700 bg-slate-800/80 px-5 py-2.5 text-sm font-medium text-white transition hover:bg-slate-800"
          >
            Go to dashboard
          </Link>
        </div>
        <details className="mt-6 text-left">
          <summary className="cursor-pointer text-xs text-slate-500 hover:text-slate-400">
            Technical details (support)
          </summary>
          <pre className="mt-2 max-h-40 overflow-auto rounded-lg border border-slate-800 bg-slate-950/80 p-3 text-left text-[11px] leading-relaxed whitespace-pre-wrap text-slate-400">
            {error.message || "Unknown error"}
            {error.digest ? `\n\nDigest: ${error.digest}` : ""}
          </pre>
        </details>
      </div>
    </div>
  );
}
