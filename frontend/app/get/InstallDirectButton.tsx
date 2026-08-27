"use client";

export function InstallDirectButton() {
  return (
    <button
      type="button"
      onClick={() => {
        /* 16.2b — PWA beforeinstallprompt / install flow */
      }}
      className="inline-flex w-full items-center justify-center rounded-xl border border-cyan-500/40 bg-cyan-500/15 px-5 py-3.5 text-sm font-semibold text-cyan-100 transition hover:bg-cyan-500/25"
    >
      Install app
    </button>
  );
}
