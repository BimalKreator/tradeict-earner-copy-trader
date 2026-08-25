"use client";

import { useCallback, useEffect, useState } from "react";
import { resolveApiBase } from "@/lib/apiBase";
import { resolveUsdInrRate } from "@/lib/currency";

/** Fetches platform USD→INR rate from GET /payments/pg-fee (null when unset/stale). */
export function useUsdInrRate() {
  const [rate, setRate] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const token =
        typeof window !== "undefined" ? localStorage.getItem("token") : null;
      const res = await fetch(`${resolveApiBase()}/payments/pg-fee`, {
        cache: "no-store",
        headers: { Authorization: `Bearer ${token ?? ""}` },
      });
      if (res.ok) {
        const data = (await res.json()) as { usdInrRate?: number | null };
        setRate(resolveUsdInrRate(data.usdInrRate));
      } else {
        setRate(null);
      }
    } catch {
      setRate(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return { rate, loading, refresh };
}
