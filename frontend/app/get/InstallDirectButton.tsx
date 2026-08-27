"use client";

import { useCallback, useEffect, useState } from "react";

/** Non-standard PWA install event — not in TypeScript DOM lib. */
interface BeforeInstallPromptEvent extends Event {
  readonly platforms: ReadonlyArray<string>;
  readonly userChoice: Promise<{
    outcome: "accepted" | "dismissed";
    platform: string;
  }>;
  prompt(): Promise<void>;
}

function isStandaloneDisplay(): boolean {
  if (typeof window === "undefined") return false;
  return window.matchMedia("(display-mode: standalone)").matches;
}

type InstallUiState = "standalone" | "installed" | "ready" | "unavailable";

export function InstallDirectButton() {
  const [deferredPrompt, setDeferredPrompt] = useState<BeforeInstallPromptEvent | null>(
    null,
  );
  const [uiState, setUiState] = useState<InstallUiState>("unavailable");
  const [installing, setInstalling] = useState(false);

  useEffect(() => {
    if (isStandaloneDisplay()) {
      setUiState("standalone");
      return;
    }

    const onBeforeInstallPrompt = (event: Event) => {
      event.preventDefault();
      setDeferredPrompt(event as BeforeInstallPromptEvent);
      setUiState("ready");
    };

    const onAppInstalled = () => {
      setDeferredPrompt(null);
      setUiState("installed");
    };

    window.addEventListener("beforeinstallprompt", onBeforeInstallPrompt);
    window.addEventListener("appinstalled", onAppInstalled);

    return () => {
      window.removeEventListener("beforeinstallprompt", onBeforeInstallPrompt);
      window.removeEventListener("appinstalled", onAppInstalled);
    };
  }, []);

  const handleInstall = useCallback(async () => {
    const promptEvent = deferredPrompt;
    if (!promptEvent) return;

    setInstalling(true);
    try {
      await promptEvent.prompt();
      await promptEvent.userChoice;
    } finally {
      setDeferredPrompt(null);
      setInstalling(false);
      if (isStandaloneDisplay()) {
        setUiState("standalone");
      } else {
        setUiState("unavailable");
      }
    }
  }, [deferredPrompt]);

  if (uiState === "standalone") {
    return (
      <p className="rounded-xl border border-emerald-500/30 bg-emerald-500/10 px-4 py-3 text-center text-sm font-medium text-emerald-200">
        App is already installed
      </p>
    );
  }

  if (uiState === "installed") {
    return (
      <p className="rounded-xl border border-emerald-500/30 bg-emerald-500/10 px-4 py-3 text-center text-sm font-medium text-emerald-200">
        Installed
      </p>
    );
  }

  if (uiState === "ready" && deferredPrompt) {
    return (
      <button
        type="button"
        onClick={() => void handleInstall()}
        disabled={installing}
        className="inline-flex w-full items-center justify-center rounded-xl border border-cyan-500/40 bg-cyan-500/15 px-5 py-3.5 text-sm font-semibold text-cyan-100 transition hover:bg-cyan-500/25 disabled:cursor-not-allowed disabled:opacity-60"
      >
        {installing ? "Installing…" : "Install app"}
      </button>
    );
  }

  return (
    <p className="text-center text-sm leading-relaxed text-white/60">
      Installation is available in Chrome on Android.
    </p>
  );
}
