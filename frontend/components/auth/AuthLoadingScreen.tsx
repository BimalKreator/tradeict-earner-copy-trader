"use client";

import { Loader2 } from "lucide-react";

export function AuthLoadingScreen({
  message = "Loading session…",
}: Readonly<{ message?: string }>) {
  return (
    <div
      className="flex min-h-screen flex-col items-center justify-center gap-3 bg-background px-4"
      aria-busy
      aria-live="polite"
    >
      <Loader2 className="h-8 w-8 animate-spin text-[#0A84FF]" aria-hidden />
      <p className="text-sm text-white/55">{message}</p>
    </div>
  );
}
