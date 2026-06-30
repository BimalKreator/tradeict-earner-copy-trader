"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { AuthLoadingScreen } from "@/components/auth/AuthLoadingScreen";
import { useAuth } from "@/context/AuthContext";

function isPlatformAdminUser(user: { role: string; adminRole?: string } | null): boolean {
  return user?.role === "ADMIN" || Boolean(user?.adminRole);
}

export function AdminAuthGate({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  const router = useRouter();
  const { isLoading, isAuthenticated, user } = useAuth();
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (isLoading) return;

    if (!isAuthenticated) {
      router.replace("/login?redirect=/admin");
      setReady(false);
      return;
    }

    if (!isPlatformAdminUser(user)) {
      router.replace("/dashboard");
      setReady(false);
      return;
    }

    setReady(true);
  }, [isLoading, isAuthenticated, user, router]);

  if (isLoading || !ready) {
    return <AuthLoadingScreen message="Checking admin session…" />;
  }

  return <>{children}</>;
}
