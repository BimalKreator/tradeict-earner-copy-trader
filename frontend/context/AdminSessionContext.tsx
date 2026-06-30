"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { resolveApiBase } from "@/lib/apiBase";

export type PlatformAdminRole = "SUPER_ADMIN" | "MANAGER" | "SUPPORT";

export type AdminSession = {
  id: string;
  email: string;
  name: string | null;
  role: PlatformAdminRole;
};

type AdminSessionContextValue = {
  loading: boolean;
  admin: AdminSession | null;
  error: string | null;
  refresh: () => Promise<void>;
  isSuperAdmin: boolean;
  canViewAuditLogs: boolean;
};

const AdminSessionContext = createContext<AdminSessionContextValue | null>(null);

function parseAdminSession(data: unknown): AdminSession | null {
  if (typeof data !== "object" || data === null) return null;
  const row = data as { admin?: unknown };
  if (typeof row.admin !== "object" || row.admin === null) return null;
  const admin = row.admin as Record<string, unknown>;
  if (typeof admin.id !== "string" || typeof admin.email !== "string") return null;
  const roleRaw =
    typeof admin.role === "string" ? admin.role.trim().toUpperCase() : "";
  const role =
    roleRaw === "SUPER_ADMIN" ||
    roleRaw === "MANAGER" ||
    roleRaw === "SUPPORT"
      ? (roleRaw as PlatformAdminRole)
      : "SUPER_ADMIN";
  return {
    id: admin.id,
    email: admin.email,
    name: typeof admin.name === "string" ? admin.name : null,
    role,
  };
}

export function AdminSessionProvider({ children }: { children: ReactNode }) {
  const [loading, setLoading] = useState(true);
  const [admin, setAdmin] = useState<AdminSession | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const token =
      typeof window !== "undefined" ? localStorage.getItem("token") : null;
    if (!token) {
      setAdmin(null);
      setError("Not signed in");
      setLoading(false);
      return;
    }

    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`${resolveApiBase()}/admin/me`, {
        headers: { Authorization: `Bearer ${token}` },
        cache: "no-store",
      });
      if (!res.ok) {
        const body: unknown = await res.json().catch(() => ({}));
        const msg =
          typeof body === "object" &&
          body !== null &&
          "error" in body &&
          typeof (body as { error?: unknown }).error === "string"
            ? (body as { error: string }).error
            : `Failed to load admin session (${res.status})`;
        throw new Error(msg);
      }
      const parsed = parseAdminSession(await res.json());
      if (!parsed) throw new Error("Invalid admin session response");
      setAdmin(parsed);
    } catch (e) {
      setAdmin(null);
      setError(e instanceof Error ? e.message : "Failed to load admin session");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const value = useMemo<AdminSessionContextValue>(
    () => ({
      loading,
      admin,
      error,
      refresh,
      isSuperAdmin: admin?.role === "SUPER_ADMIN",
      canViewAuditLogs:
        admin?.role === "SUPER_ADMIN" || admin?.role === "MANAGER",
    }),
    [admin, error, loading, refresh],
  );

  return (
    <AdminSessionContext.Provider value={value}>
      {children}
    </AdminSessionContext.Provider>
  );
}

export function useAdminSession(): AdminSessionContextValue {
  const ctx = useContext(AdminSessionContext);
  if (!ctx) {
    throw new Error("useAdminSession must be used within AdminSessionProvider");
  }
  return ctx;
}
