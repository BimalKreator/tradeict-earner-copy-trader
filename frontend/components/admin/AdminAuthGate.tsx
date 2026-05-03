"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

const ENV_API_BASE =
  process.env.NEXT_PUBLIC_API_URL?.trim().replace(/\/$/, "") ?? "";

function resolveApiBase(): string {
  if (ENV_API_BASE) return ENV_API_BASE;
  if (typeof window !== "undefined") {
    return `${window.location.origin.replace(/\/$/, "")}/api`;
  }
  return "";
}

export function AdminAuthGate({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  const router = useRouter();
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let cancelled = false;

    async function validate() {
      const token =
        typeof window !== "undefined"
          ? localStorage.getItem("token")?.trim() ?? ""
          : "";
      if (!token) {
        router.replace("/login?redirect=/admin");
        return;
      }

      const base = resolveApiBase();
      if (!base) {
        router.replace("/login?redirect=/admin");
        return;
      }

      try {
        const res = await fetch(`${base}/user/me`, {
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          cache: "no-store",
          credentials: "include",
        });

        if (!res.ok) {
          localStorage.removeItem("token");
          router.replace("/login?redirect=/admin");
          return;
        }

        const data: unknown = await res.json().catch(() => null);
        const role =
          data &&
          typeof data === "object" &&
          "role" in data &&
          typeof (data as { role: unknown }).role === "string"
            ? (data as { role: string }).role
            : null;

        if (cancelled) return;

        if (role !== "ADMIN") {
          router.replace("/dashboard");
          return;
        }

        setReady(true);
      } catch {
        if (!cancelled) {
          localStorage.removeItem("token");
          router.replace("/login?redirect=/admin");
        }
      }
    }

    void validate();
    return () => {
      cancelled = true;
    };
  }, [router]);

  if (!ready) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background px-4">
        <p className="text-sm text-white/55">Checking admin session…</p>
      </div>
    );
  }

  return <>{children}</>;
}
