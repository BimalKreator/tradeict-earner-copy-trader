"use client";

import { RouteErrorView } from "@/components/common/RouteErrorView";

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-[#0b0f19] font-sans text-white antialiased">
        <RouteErrorView error={error} reset={reset} />
      </body>
    </html>
  );
}
