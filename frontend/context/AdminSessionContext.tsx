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
import { adminFetch } from "@/lib/adminAuth";

/** Platform admin RBAC — SUPPORT removed; unknown roles fail closed (null). */
export type PlatformAdminRole = "SUPER_ADMIN" | "MANAGER";

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
  /** Resolved platform RBAC tier (SUPER_ADMIN | MANAGER) or null. */
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
  if (role === "SUPER_ADMIN" || role === "MANAGER") {
    return role;
  }
  // Unknown / SUPPORT / missing → null (fail closed — never SUPER_ADMIN)
  return null;
}

/** Matches backend `isPlatformAdminUser`: ADMIN + SUPER_ADMIN|MANAGER. */
function isPlatformAdminUser(user: AuthUser | null | undefined): boolean {
  return (
    user?.role === "ADMIN" && parsePlatformAdminRole(user.adminRole) != null
  );
}

function platformRoleFromAuthUser(
  user: AuthUser | null | undefined,
): PlatformAdminRole | null {
  if (!isPlatformAdminUser(user)) return null;
  return parsePlatformAdminRole(user?.adminRole);
}

function parseAdminSession(data: unknown): AdminSession | null {
  if (typeof data !== "object" || data === null) return null;
  const row = data as { admin?: unknown };
  if (typeof row.admin !== "object" || row.admin === null) return null;
  const admin = row.admin as Record<string, unknown>;
  if (typeof admin.id !== "string" || typeof admin.email !== "string") return null;

  const role =
    parsePlatformAdminRole(admin.adminRole) ??
    parsePlatformAdminRole(admin.role);
  if (!role) return null;

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
  const { isLoading: authLoading, user, refreshUser } = useAuth();
  const [loading, setLoading] = useState(true);
  const [admin, setAdmin] = useState<AdminSession | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (authLoading) return;

    if (!isPlatformAdminUser(user)) {
      setAdmin(null);
      setError(user ? "Not a platform admin" : "Not signed in");
      setLoading(false);
      return;
    }

    setLoading(true);
    setError(null);

    const fallback = sessionFromAuthUser(user);

    try {
      // Cookie-only — no localStorage Bearer
      const res = await adminFetch("/admin/me");

      if (res.ok) {
        const parsed = parseAdminSession(await res.json());
        if (parsed) {
          setAdmin(parsed);
          return;
        }
        // Invalid/unknown role from API → fail closed
        setAdmin(null);
        setError("Admin role not recognized");
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
      // Do not fall back to a privileged role on error — fail closed.
      // Only keep fallback when it already parsed as SUPER_ADMIN|MANAGER.
      if (fallback) {
        setAdmin(fallback);
        setError(
          e instanceof Error
            ? `Using session role (${fallback.role}): ${e.message}`
            : `Using session role (${fallback.role})`,
        );
      } else {
        setAdmin(null);
        setError(e instanceof Error ? e.message : "Failed to load admin session");
      }
    } finally {
      setLoading(false);
    }
  }, [authLoading, user]);

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
