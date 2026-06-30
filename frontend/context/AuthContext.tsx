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
import {
  normalizeSalesTeamRole,
  type SalesTeamRole,
} from "@/lib/roles";

const TOKEN_STORAGE_KEY = "token";

export type AuthUser = {
  id: string;
  email: string;
  name: string | null;
  /** USER | ADMIN | EXECUTIVE | MANAGER | SENIOR_MANAGER */
  role: string;
  /** Platform RBAC tier when role is ADMIN. */
  adminRole?: "SUPER_ADMIN" | "MANAGER" | "SUPPORT";
  mobile?: string | null;
  address?: string | null;
  panNumber?: string | null;
  aadharNumber?: string | null;
  status?: string;
  pendingApprovalFields?: string[];
};

type AuthContextValue = {
  isLoading: boolean;
  isAuthenticated: boolean;
  token: string | null;
  user: AuthUser | null;
  /** True when role is EXECUTIVE, MANAGER, or SENIOR_MANAGER. */
  isSalesTeamMember: boolean;
  salesTeamRole: SalesTeamRole | null;
  setSession: (token: string, user?: AuthUser | null) => void;
  logout: () => Promise<void>;
  refreshUser: () => Promise<void>;
};

const AuthContext = createContext<AuthContextValue | null>(null);

function readStoredToken(): string {
  if (typeof window === "undefined") return "";
  return localStorage.getItem(TOKEN_STORAGE_KEY)?.trim() ?? "";
}

function isJwtExpired(token: string): boolean {
  try {
    const segment = token.split(".")[1];
    if (!segment) return true;
    const payload = JSON.parse(atob(segment)) as { exp?: unknown };
    if (typeof payload.exp !== "number") return false;
    return payload.exp * 1000 < Date.now();
  } catch {
    return false;
  }
}

function parsePlatformAdminRole(
  value: unknown,
): AuthUser["adminRole"] | undefined {
  if (typeof value !== "string") return undefined;
  const role = value.trim().toUpperCase();
  if (role === "SUPER_ADMIN" || role === "MANAGER" || role === "SUPPORT") {
    return role;
  }
  return undefined;
}

function parseAuthUser(data: unknown): AuthUser | null {
  if (typeof data !== "object" || data === null) return null;
  const row = data as Record<string, unknown>;
  if (typeof row.id !== "string" || typeof row.email !== "string") return null;
  const role =
    typeof row.role === "string" ? row.role.trim().toUpperCase() : "USER";
  const adminRole = parsePlatformAdminRole(row.adminRole);
  return {
    id: row.id,
    email: row.email,
    name: typeof row.name === "string" ? row.name : null,
    role,
    ...(adminRole ? { adminRole } : {}),
    mobile: typeof row.mobile === "string" ? row.mobile : null,
    address: typeof row.address === "string" ? row.address : null,
    panNumber: typeof row.panNumber === "string" ? row.panNumber : null,
    aadharNumber:
      typeof row.aadharNumber === "string" ? row.aadharNumber : null,
    status: typeof row.status === "string" ? row.status : undefined,
    pendingApprovalFields: Array.isArray(row.pendingApprovalFields)
      ? row.pendingApprovalFields.filter((f): f is string => typeof f === "string")
      : undefined,
  };
}

export function AuthProvider({ children }: Readonly<{ children: ReactNode }>) {
  const [isLoading, setIsLoading] = useState(true);
  const [token, setToken] = useState<string | null>(null);
  const [user, setUser] = useState<AuthUser | null>(null);

  const fetchMe = useCallback(async (bearerToken: string): Promise<AuthUser | null> => {
    const base = resolveApiBase();
    if (!base) return null;

    const headers: HeadersInit = { "Content-Type": "application/json" };
    if (bearerToken) {
      headers.Authorization = `Bearer ${bearerToken}`;
    }

    const res = await fetch(`${base}/user/me`, {
      headers,
      credentials: "include",
      cache: "no-store",
    });

    if (!res.ok) return null;
    const data: unknown = await res.json().catch(() => null);
    return parseAuthUser(data);
  }, []);

  const hydrate = useCallback(async () => {
    const base = resolveApiBase();
    let stored = readStoredToken();

    if (stored && isJwtExpired(stored)) {
      localStorage.removeItem(TOKEN_STORAGE_KEY);
      stored = "";
    }

    if (!base) {
      setToken(stored || null);
      setUser(null);
      setIsLoading(false);
      return;
    }

    try {
      const me = await fetchMe(stored);
      if (me) {
        setUser(me);
        setToken(stored || null);
      } else {
        if (stored) localStorage.removeItem(TOKEN_STORAGE_KEY);
        setToken(null);
        setUser(null);
      }
    } catch {
      if (stored) localStorage.removeItem(TOKEN_STORAGE_KEY);
      setToken(null);
      setUser(null);
    } finally {
      setIsLoading(false);
    }
  }, [fetchMe]);

  useEffect(() => {
    void hydrate();
  }, [hydrate]);

  const setSession = useCallback(
    (newToken: string, sessionUser?: AuthUser | null) => {
      const trimmed = newToken.trim();
      if (trimmed) {
        localStorage.setItem(TOKEN_STORAGE_KEY, trimmed);
        setToken(trimmed);
      }
      if (sessionUser) {
        setUser(sessionUser);
      } else if (trimmed) {
        void fetchMe(trimmed).then((me) => {
          if (me) setUser(me);
        });
      }
      setIsLoading(false);
    },
    [fetchMe],
  );

  const refreshUser = useCallback(async () => {
    const stored = readStoredToken();
    const me = await fetchMe(stored);
    if (me) {
      setUser(me);
      setToken(stored || null);
    }
  }, [fetchMe]);

  const logout = useCallback(async () => {
    const stored = readStoredToken();
    const base = resolveApiBase();
    if (base) {
      try {
        await fetch(`${base}/auth/logout`, {
          method: "POST",
          credentials: "include",
          headers: stored ? { Authorization: `Bearer ${stored}` } : {},
        });
      } catch {
        /* clear client session regardless */
      }
    }
    localStorage.removeItem(TOKEN_STORAGE_KEY);
    setToken(null);
    setUser(null);
  }, []);

  const salesTeamRole = useMemo((): SalesTeamRole | null => {
    return normalizeSalesTeamRole(user?.role);
  }, [user?.role]);

  const value = useMemo<AuthContextValue>(
    () => ({
      isLoading,
      isAuthenticated: Boolean(user),
      token,
      user,
      isSalesTeamMember: salesTeamRole != null,
      salesTeamRole,
      setSession,
      logout,
      refreshUser,
    }),
    [isLoading, token, user, salesTeamRole, setSession, logout, refreshUser],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error("useAuth must be used within AuthProvider");
  }
  return ctx;
}
