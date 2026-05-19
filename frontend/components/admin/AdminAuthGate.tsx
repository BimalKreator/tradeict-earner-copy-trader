"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { AuthLoadingScreen } from "@/components/auth/AuthLoadingScreen";
import { useAuth } from "@/context/AuthContext";

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

    if (user?.role !== "ADMIN") {
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
