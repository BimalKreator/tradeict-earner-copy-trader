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

export type PlatformConfig = {
  maintenanceMode: boolean;
  maintenanceMessage: string | null;
};

const DEFAULT_CONFIG: PlatformConfig = {
  maintenanceMode: false,
  maintenanceMessage: null,
};

type PlatformConfigContextValue = {
  config: PlatformConfig;
  loading: boolean;
  refresh: () => Promise<void>;
};

const PlatformConfigContext = createContext<PlatformConfigContextValue>({
  config: DEFAULT_CONFIG,
  loading: true,
  refresh: async () => {},
});

export function PlatformConfigProvider({ children }: { children: ReactNode }) {
  const [config, setConfig] = useState<PlatformConfig>(DEFAULT_CONFIG);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    const base = resolveApiBase();
    if (!base) {
      setLoading(false);
      return;
    }
    try {
      const res = await fetch(`${base}/public/platform-config`, {
        cache: "no-store",
      });
      if (!res.ok) return;
      const data = (await res.json()) as Partial<PlatformConfig>;
      setConfig({
        maintenanceMode: data.maintenanceMode === true,
        maintenanceMessage:
          typeof data.maintenanceMessage === "string"
            ? data.maintenanceMessage
            : data.maintenanceMessage === null
              ? null
              : null,
      });
    } catch {
      /* keep last known config */
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const id = window.setInterval(() => void refresh(), 60_000);
    return () => window.clearInterval(id);
  }, [refresh]);

  const value = useMemo(
    () => ({ config, loading, refresh }),
    [config, loading, refresh],
  );

  return (
    <PlatformConfigContext.Provider value={value}>
      {children}
    </PlatformConfigContext.Provider>
  );
}

export function usePlatformConfig(): PlatformConfigContextValue {
  return useContext(PlatformConfigContext);
}
