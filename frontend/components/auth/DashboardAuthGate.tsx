"use client";

import { usePathname, useRouter } from "next/navigation";
import { useEffect } from "react";
import { AuthLoadingScreen } from "@/components/auth/AuthLoadingScreen";
import { useAuth } from "@/context/AuthContext";

export function DashboardAuthGate({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  const router = useRouter();
  const pathname = usePathname();
  const { isLoading, isAuthenticated } = useAuth();

  useEffect(() => {
    if (isLoading || isAuthenticated) return;
    const redirect = encodeURIComponent(pathname || "/dashboard");
    router.replace(`/login?redirect=${redirect}`);
  }, [isLoading, isAuthenticated, pathname, router]);

  if (isLoading) {
    return <AuthLoadingScreen message="Checking your session…" />;
  }

  if (!isAuthenticated) {
    return <AuthLoadingScreen message="Redirecting to sign in…" />;
  }

  return <>{children}</>;
}
