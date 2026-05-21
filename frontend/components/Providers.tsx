"use client";

import type { ReactNode } from "react";
import { MaintenanceBanner } from "@/components/MaintenanceBanner";
import { AuthProvider } from "@/context/AuthContext";
import { PlatformConfigProvider } from "@/context/PlatformConfigContext";

export function Providers({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <PlatformConfigProvider>
      <MaintenanceBanner />
      <AuthProvider>{children}</AuthProvider>
    </PlatformConfigProvider>
  );
}
