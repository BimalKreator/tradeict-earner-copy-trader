"use client";

import type { ReactNode } from "react";
import { AuthProvider } from "@/context/AuthContext";

export function Providers({ children }: Readonly<{ children: ReactNode }>) {
  return <AuthProvider>{children}</AuthProvider>;
}
