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
import { useAuth, type AuthUser } from "@/context/AuthContext";
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
  /** Resolved platform RBAC tier (SUPER_ADMIN | MANAGER | SUPPORT). */
  platformAdminRole: PlatformAdminRole | null;
  isPlatformAdmin: boolean;
  isSuperAdmin: boolean;
  /** SUPER_ADMIN and platform MANAGER — full admin sidebar. */
  canSeeFullAdminNav: boolean;
  canViewAuditLogs: boolean;
};

const AdminSessionContext = createContext<AdminSessionContextValue | null>(null);

function parsePlatformAdminRole(value: unknown): PlatformAdminRole | null {
  if (typeof value !== "string") return null;
  const role = value.trim().toUpperCase();
  if (role === "SUPER_ADMIN" || role === "MANAGER" || role === "SUPPORT") {
    return role;
  }
  return null;
}

function isPlatformAdminUser(user: AuthUser | null | undefined): boolean {
  return user?.role === "ADMIN" || Boolean(user?.adminRole);
}

function platformRoleFromAuthUser(user: AuthUser | null | undefined): PlatformAdminRole | null {
  if (!isPlatformAdminUser(user)) return null;
  return user?.adminRole ?? "SUPER_ADMIN";
}

function parseAdminSession(data: unknown): AdminSession | null {
  if (typeof data !== "object" || data === null) return null;
  const row = data as { admin?: unknown };
  if (typeof row.admin !== "object" || row.admin === null) return null;
  const admin = row.admin as Record<string, unknown>;
  if (typeof admin.id !== "string" || typeof admin.email !== "string") return null;

  const role =
    parsePlatformAdminRole(admin.adminRole) ??
    parsePlatformAdminRole(admin.role) ??
    "SUPER_ADMIN";

  return {
    id: admin.id,
    email: admin.email,
    name: typeof admin.name === "string" ? admin.name : null,
    role,
  };
}

function sessionFromAuthUser(user: AuthUser | null): AdminSession | null {
  const role = platformRoleFromAuthUser(user);
  if (!user || !role) return null;
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    role,
  };
}

export function AdminSessionProvider({ children }: { children: ReactNode }) {
  const { isLoading: authLoading, token, user, refreshUser } = useAuth();
  const [loading, setLoading] = useState(true);
  const [admin, setAdmin] = useState<AdminSession | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (authLoading) return;

    const bearer = token?.trim() || null;
    if (!bearer) {
      setAdmin(null);
      setError("Not signed in");
      setLoading(false);
      return;
    }

    if (!isPlatformAdminUser(user)) {
      setAdmin(null);
      setError("Not a platform admin");
      setLoading(false);
      return;
    }

    setLoading(true);
    setError(null);

    const fallback = sessionFromAuthUser(user);

    try {
      const res = await fetch(`${resolveApiBase()}/admin/me`, {
        headers: { Authorization: `Bearer ${bearer}` },
        credentials: "include",
        cache: "no-store",
      });

      if (res.ok) {
        const parsed = parseAdminSession(await res.json());
        if (parsed) {
          setAdmin(parsed);
          return;
        }
      }

      if (fallback) {
        setAdmin(fallback);
        if (!res.ok) {
          setError(
            `Using cached admin role (${fallback.role}); /admin/me returned ${res.status}`,
          );
        }
        return;
      }

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

      throw new Error("Invalid admin session response");
    } catch (e) {
      if (fallback) {
        setAdmin(fallback);
        setError(
          e instanceof Error
            ? `Using cached admin role (${fallback.role}): ${e.message}`
            : `Using cached admin role (${fallback.role})`,
        );
      } else {
        setAdmin(null);
        setError(e instanceof Error ? e.message : "Failed to load admin session");
      }
    } finally {
      setLoading(false);
    }
  }, [authLoading, token, user]);

  useEffect(() => {
    if (authLoading || !isPlatformAdminUser(user)) return;
    void refreshUser();
  }, [authLoading, refreshUser, user?.adminRole, user?.id, user?.role]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const platformAdminRole =
    admin?.role ?? platformRoleFromAuthUser(user ?? null);

  const value = useMemo<AdminSessionContextValue>(() => {
    const canSeeFullAdminNav =
      platformAdminRole === "SUPER_ADMIN" || platformAdminRole === "MANAGER";

    return {
      loading: authLoading || loading,
      admin,
      error,
      refresh,
      platformAdminRole,
      isPlatformAdmin: platformAdminRole != null,
      isSuperAdmin: platformAdminRole === "SUPER_ADMIN",
      canSeeFullAdminNav,
      canViewAuditLogs: canSeeFullAdminNav,
    };
  }, [admin, authLoading, error, loading, platformAdminRole, refresh]);

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
