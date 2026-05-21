"use client";

import { usePlatformConfig } from "@/context/PlatformConfigContext";

const DEFAULT_MESSAGE =
  "The platform is temporarily under maintenance. Please check back shortly.";

/**
 * Fixed red notice at the top of the viewport. A spacer below reserves height so
 * headers and sidebars are not covered.
 */
export function MaintenanceBanner() {
  const { config } = usePlatformConfig();

  if (!config.maintenanceMode) {
    return null;
  }

  const text =
    config.maintenanceMessage?.trim() || DEFAULT_MESSAGE;

  return (
    <>
      <div
        role="alert"
        className="fixed inset-x-0 top-0 z-[200] border-b border-red-900/50 bg-red-600 px-4 py-2.5 text-center text-sm font-medium leading-snug text-white shadow-lg"
      >
        {text}
      </div>
      <div className="h-11 shrink-0" aria-hidden />
    </>
  );
}
