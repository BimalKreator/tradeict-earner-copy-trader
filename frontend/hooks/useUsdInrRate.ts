"use client";

import { useCallback, useEffect, useState } from "react";
import { resolveApiBase } from "@/lib/apiBase";
import { FALLBACK_USD_INR_RATE, getUsdInrRate } from "@/lib/currency";

/** Fetches live USD→INR rate from GET /payments/pg-fee (same source as checkout). */
export function useUsdInrRate() {
  const [rate, setRate] = useState(FALLBACK_USD_INR_RATE);
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
        const data = (await res.json()) as { usdInrRate?: number };
        setRate(getUsdInrRate(data.usdInrRate));
      }
    } catch {
      setRate(FALLBACK_USD_INR_RATE);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return { rate, loading, refresh };
}
