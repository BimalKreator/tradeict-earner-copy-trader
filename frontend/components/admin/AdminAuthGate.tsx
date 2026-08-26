"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { AuthLoadingScreen } from "@/components/auth/AuthLoadingScreen";
import { useAuth } from "@/context/AuthContext";

/** Matches backend `isPlatformAdminUser`: ADMIN + SUPER_ADMIN|MANAGER. */
function isPlatformAdminUser(
  user: { role: string; adminRole?: string | null } | null,
): boolean {
  if (user?.role !== "ADMIN" || !user.adminRole) return false;
  const role = user.adminRole.trim().toUpperCase();
  return role === "SUPER_ADMIN" || role === "MANAGER";
}

export function AdminAuthGate({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  const router = useRouter();
  const { isLoading, isAuthenticated, user } = useAuth();
  const [ready, setReady] = useState(false);
  const [denied, setDenied] = useState(false);

  useEffect(() => {
    if (isLoading) return;

    if (!isAuthenticated) {
      router.replace("/login?redirect=/admin");
      setReady(false);
      setDenied(false);
      return;
    }

    if (!isPlatformAdminUser(user)) {
      setDenied(true);
      setReady(false);
      const timer = window.setTimeout(() => {
        router.replace("/");
      }, 2500);
      return () => window.clearTimeout(timer);
    }

    setDenied(false);
    setReady(true);
  }, [isLoading, isAuthenticated, user, router]);

  if (isLoading) {
    return <AuthLoadingScreen message="Checking admin session…" />;
  }

  if (denied) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-3 bg-[#0a0a12] px-6 text-center">
        <p className="text-base font-medium text-white/90">
          You don&apos;t have access to the admin panel
        </p>
        <p className="text-sm text-white/50">Redirecting to your dashboard…</p>
      </div>
    );
  }

  if (!ready) {
    return <AuthLoadingScreen message="Checking admin session…" />;
  }

  return <>{children}</>;
}
