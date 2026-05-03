"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Loader2, ScanSearch, Save, X } from "lucide-react";

const ENV_API_BASE =
  process.env.NEXT_PUBLIC_API_URL?.trim().replace(/\/$/, "") ?? "";

function resolveAdminApiBase(): string {
  if (ENV_API_BASE) return ENV_API_BASE;
  if (typeof window !== "undefined") {
    return `${window.location.origin.replace(/\/$/, "")}/api`;
  }
  return "";
}

function authHeaders(): HeadersInit {
  const token =
    typeof window !== "undefined" ? localStorage.getItem("token") : null;
  return {
    "Content-Type": "application/json",
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}

type StrategyListItem = {
  id: string;
  title: string;
  cosmicEmail: string;
  hasCosmicPassword?: boolean;
  scraperStudioSelectors?: unknown;
};

type InspectElement = {
  x: number;
  y: number;
  width: number;
  height: number;
  text: string;
  selector: string;
};

type InspectResponse = {
  screenshotBase64: string;
  elements: InspectElement[];
  captureWidth: number;
  captureHeight: number;
};

const SLOT_OPTIONS: { value: string; label: string }[] = [
  { value: "", label: "— Choose slot —" },
  { value: "symbol", label: "Symbol selector" },
  { value: "side", label: "Side selector" },
  { value: "size", label: "Size selector" },
  { value: "avg_price", label: "Avg price selector" },
  { value: "current_price", label: "Current price selector" },
  { value: "position_row", label: "Position row container" },
  { value: "login_email", label: "Login email field" },
  { value: "login_password", label: "Login password field" },
  { value: "login_submit", label: "Login submit button" },
  { value: "wallet_balance", label: "Wallet total balance" },
  { value: "take_profit", label: "Take profit" },
  { value: "stop_loss", label: "Stop loss" },
  { value: "__custom__", label: "Custom key…" },
];

function normalizeSelectors(raw: unknown): Record<string, string> {
  if (
    !raw ||
    typeof raw !== "object" ||
    Array.isArray(raw) ||
    raw === null
  ) {
    return {};
  }
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (typeof k === "string" && typeof v === "string") {
      out[k.trim()] = v;
    }
  }
  return out;
}

export default function AdminScraperStudioPage() {
  const apiBase = useMemo(() => resolveAdminApiBase(), []);

  const [strategies, setStrategies] = useState<StrategyListItem[]>([]);
  const [strategyId, setStrategyId] = useState("");
  const [url, setUrl] = useState("https://app.cosmic.trade/portfolio");
  const [manualEmail, setManualEmail] = useState("");
  const [manualPassword, setManualPassword] = useState("");

  const [inspectLoading, setInspectLoading] = useState(false);
  const [inspectError, setInspectError] = useState<string | null>(null);
  const [inspect, setInspect] = useState<InspectResponse | null>(null);

  const [selectedEl, setSelectedEl] = useState<InspectElement | null>(null);
  const [assignSlot, setAssignSlot] = useState("");
  const [customSlotKey, setCustomSlotKey] = useState("");
  const [selectorDraft, setSelectorDraft] = useState("");

  const [mappings, setMappings] = useState<Record<string, string>>({});
  const [saveLoading, setSaveLoading] = useState(false);
  const [saveMessage, setSaveMessage] = useState<string | null>(null);

  const loadStrategies = useCallback(async () => {
    const res = await fetch(`${apiBase}/admin/strategies`, {
      headers: authHeaders(),
    });
    if (!res.ok) throw new Error(await res.text());
    const data = (await res.json()) as StrategyListItem[];
    setStrategies(data);
  }, [apiBase]);

  useEffect(() => {
    void loadStrategies().catch(() => {
      setInspectError("Could not load strategies.");
    });
  }, [loadStrategies]);

  useEffect(() => {
    const s = strategies.find((x) => x.id === strategyId);
    setMappings(normalizeSelectors(s?.scraperStudioSelectors));
  }, [strategyId, strategies]);

  useEffect(() => {
    if (selectedEl) {
      setSelectorDraft(selectedEl.selector);
      setAssignSlot("");
      setCustomSlotKey("");
    }
  }, [selectedEl]);

  async function runInspect(e: React.FormEvent) {
    e.preventDefault();
    setInspectError(null);
    setInspectLoading(true);
    setInspect(null);
    setSelectedEl(null);
    try {
      const body: Record<string, string> = { url: url.trim() };
      if (strategyId.trim()) {
        body.strategyId = strategyId.trim();
      } else {
        if (manualEmail.trim()) body.email = manualEmail.trim();
        if (manualPassword.trim()) body.password = manualPassword.trim();
      }

      const res = await fetch(`${apiBase}/admin/scraper-studio/inspect`, {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const t = await res.text();
        throw new Error(t || res.statusText);
      }
      const data = (await res.json()) as InspectResponse;
      if (
        !data.screenshotBase64 ||
        !Array.isArray(data.elements) ||
        typeof data.captureWidth !== "number" ||
        typeof data.captureHeight !== "number"
      ) {
        throw new Error("Invalid inspect response");
      }
      setInspect(data);
    } catch (err) {
      setInspectError(err instanceof Error ? err.message : String(err));
    } finally {
      setInspectLoading(false);
    }
  }

  function applyMapping() {
    const sel = selectorDraft.trim();
    if (!sel) return;
    let slot = assignSlot;
    if (slot === "__custom__") {
      slot = customSlotKey.trim();
      if (!slot) return;
    }
    if (!slot) return;
    setMappings((prev) => ({ ...prev, [slot]: sel }));
    setSaveMessage(`Applied “${slot}” locally — click Save to persist.`);
  }

  async function saveMappingsToStrategy() {
    if (!strategyId.trim()) {
      setSaveMessage("Select a strategy to save mappings.");
      return;
    }
    setSaveLoading(true);
    setSaveMessage(null);
    try {
      const res = await fetch(`${apiBase}/admin/strategies/${strategyId}`, {
        method: "PUT",
        headers: authHeaders(),
        body: JSON.stringify({ scraperStudioSelectors: mappings }),
      });
      if (!res.ok) {
        const t = await res.text();
        throw new Error(t || res.statusText);
      }
      setSaveMessage("Saved selector mappings for this strategy.");
      await loadStrategies();
    } catch (err) {
      setSaveMessage(err instanceof Error ? err.message : String(err));
    } finally {
      setSaveLoading(false);
    }
  }

  const cw = inspect?.captureWidth ?? 1;
  const ch = inspect?.captureHeight ?? 1;

  return (
    <div className="space-y-8 text-white">
      <header className="flex flex-col gap-2 border-b border-white/10 pb-6">
        <div className="flex items-center gap-3">
          <ScanSearch className="h-8 w-8 text-primary" aria-hidden />
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">
              Visual Scraper Studio
            </h1>
            <p className="mt-1 max-w-2xl text-sm text-white/65">
              Capture a page after login, hover highlighted regions, and assign
              CSS selector paths to named slots for each strategy. Credentials
              load securely from the strategy when selected.
            </p>
          </div>
        </div>
      </header>

      <form
        onSubmit={runInspect}
        className="glass-card space-y-4 rounded-xl border border-glassBorder p-6"
      >
        <div className="grid gap-4 md:grid-cols-2">
          <label className="block space-y-1.5">
            <span className="text-xs font-medium uppercase tracking-wide text-white/50">
              Target URL
            </span>
            <input
              type="url"
              required
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              className="w-full rounded-lg border border-white/15 bg-black/30 px-3 py-2 text-sm text-white outline-none ring-primary/30 placeholder:text-white/35 focus:ring-2"
              placeholder="https://app.cosmic.trade/portfolio"
            />
          </label>
          <label className="block space-y-1.5">
            <span className="text-xs font-medium uppercase tracking-wide text-white/50">
              Strategy (optional — uses stored Cosmic credentials)
            </span>
            <select
              value={strategyId}
              onChange={(e) => setStrategyId(e.target.value)}
              className="w-full rounded-lg border border-white/15 bg-black/30 px-3 py-2 text-sm text-white outline-none focus:ring-2 ring-primary/30"
            >
              <option value="">— Manual credentials below —</option>
              {strategies.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.title}
                  {s.hasCosmicPassword ? "" : " (no password saved)"}
                </option>
              ))}
            </select>
          </label>
        </div>

        {!strategyId.trim() ? (
          <div className="grid gap-4 md:grid-cols-2">
            <label className="block space-y-1.5">
              <span className="text-xs font-medium uppercase tracking-wide text-white/50">
                Email / username (manual)
              </span>
              <input
                type="text"
                value={manualEmail}
                onChange={(e) => setManualEmail(e.target.value)}
                autoComplete="off"
                className="w-full rounded-lg border border-white/15 bg-black/30 px-3 py-2 text-sm outline-none focus:ring-2 ring-primary/30"
              />
            </label>
            <label className="block space-y-1.5">
              <span className="text-xs font-medium uppercase tracking-wide text-white/50">
                Password (manual)
              </span>
              <input
                type="password"
                value={manualPassword}
                onChange={(e) => setManualPassword(e.target.value)}
                autoComplete="off"
                className="w-full rounded-lg border border-white/15 bg-black/30 px-3 py-2 text-sm outline-none focus:ring-2 ring-primary/30"
              />
            </label>
          </div>
        ) : null}

        <button
          type="submit"
          disabled={inspectLoading}
          className="inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2.5 text-sm font-semibold text-primary-foreground shadow-lg shadow-primary/25 transition hover:opacity-95 disabled:opacity-50"
        >
          {inspectLoading ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <ScanSearch className="h-4 w-4" />
          )}
          Run inspect
        </button>

        {inspectError ? (
          <p className="text-sm text-red-400">{inspectError}</p>
        ) : null}
      </form>

      {inspect ? (
        <section className="space-y-4">
          <h2 className="text-lg font-medium text-white">Capture</h2>
          <div className="relative overflow-auto rounded-xl border border-white/10 bg-black/40 p-4">
            <div
              className="relative mx-auto max-w-full"
              style={{
                aspectRatio: `${cw} / ${ch}`,
                maxHeight: "75vh",
              }}
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                alt="Page capture"
                src={`data:image/png;base64,${inspect.screenshotBase64}`}
                className="absolute inset-0 h-full w-full select-none rounded-md object-fill"
                draggable={false}
              />
              <div className="absolute inset-0 rounded-md">
                {inspect.elements.map((el, i) => (
                  <button
                    key={`${i}-${el.selector.slice(0, 48)}`}
                    type="button"
                    title={el.selector}
                    className="absolute z-10 cursor-pointer border-2 border-transparent bg-transparent transition-colors hover:border-blue-500 hover:bg-blue-500/10"
                    style={{
                      left: `${(el.x / cw) * 100}%`,
                      top: `${(el.y / ch) * 100}%`,
                      width: `${(el.width / cw) * 100}%`,
                      height: `${(el.height / ch) * 100}%`,
                    }}
                    onClick={() => setSelectedEl(el)}
                  />
                ))}
              </div>
            </div>
          </div>
          <p className="text-xs text-white/45">
            {inspect.elements.length} elements · capture {cw}×{ch}px — hover
            for blue outline, click to inspect.
          </p>
        </section>
      ) : null}

      {/* Side panel */}
      {selectedEl ? (
        <>
          <button
            type="button"
            aria-label="Close panel"
            className="fixed inset-0 z-40 bg-black/55 md:hidden"
            onClick={() => setSelectedEl(null)}
          />
          <aside className="fixed bottom-0 left-0 right-0 z-50 max-h-[85vh] overflow-y-auto rounded-t-2xl border border-white/15 bg-[#0d1117] p-6 shadow-2xl md:bottom-auto md:left-auto md:top-0 md:h-full md:max-h-none md:w-[min(420px,100vw)] md:rounded-none md:border-l md:border-t-0">
            <div className="mb-4 flex items-start justify-between gap-3">
              <h3 className="text-lg font-semibold text-white">
                Element detail
              </h3>
              <button
                type="button"
                onClick={() => setSelectedEl(null)}
                className="rounded-lg p-2 text-white/60 hover:bg-white/10 hover:text-white"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            <div className="space-y-3 text-sm">
              <div>
                <p className="text-xs font-medium uppercase tracking-wide text-white/45">
                  Text
                </p>
                <pre className="mt-1 max-h-32 overflow-auto whitespace-pre-wrap rounded-lg border border-white/10 bg-black/40 p-3 text-xs text-white/85">
                  {selectedEl.text || "—"}
                </pre>
              </div>
              <label className="block space-y-1">
                <span className="text-xs font-medium uppercase tracking-wide text-white/45">
                  CSS selector (editable)
                </span>
                <textarea
                  value={selectorDraft}
                  onChange={(e) => setSelectorDraft(e.target.value)}
                  rows={4}
                  className="w-full resize-y rounded-lg border border-white/15 bg-black/40 px-3 py-2 font-mono text-xs text-primary outline-none focus:ring-2 ring-primary/40"
                />
              </label>

              <label className="block space-y-1">
                <span className="text-xs font-medium uppercase tracking-wide text-white/45">
                  Assign to slot
                </span>
                <select
                  value={assignSlot}
                  onChange={(e) => setAssignSlot(e.target.value)}
                  className="w-full rounded-lg border border-white/15 bg-black/40 px-3 py-2 text-sm outline-none focus:ring-2 ring-primary/40"
                >
                  {SLOT_OPTIONS.map((o) => (
                    <option key={o.value || "none"} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </select>
              </label>

              {assignSlot === "__custom__" ? (
                <label className="block space-y-1">
                  <span className="text-xs font-medium uppercase tracking-wide text-white/45">
                    Custom slot key
                  </span>
                  <input
                    type="text"
                    value={customSlotKey}
                    onChange={(e) => setCustomSlotKey(e.target.value)}
                    placeholder="e.g. my_custom_field"
                    className="w-full rounded-lg border border-white/15 bg-black/40 px-3 py-2 text-sm outline-none focus:ring-2 ring-primary/40"
                  />
                </label>
              ) : null}

              <button
                type="button"
                onClick={applyMapping}
                className="w-full rounded-lg border border-primary/50 bg-primary/15 px-3 py-2 text-sm font-medium text-primary hover:bg-primary/25"
              >
                Apply to mapping (local)
              </button>
            </div>

            <div className="mt-8 border-t border-white/10 pt-6">
              <h4 className="text-sm font-semibold text-white">
                Strategy mappings
              </h4>
              {!strategyId.trim() ? (
                <p className="mt-2 text-xs text-amber-400/90">
                  Select a strategy above to save mappings to the database.
                </p>
              ) : null}
              <pre className="mt-3 max-h-40 overflow-auto rounded-lg border border-white/10 bg-black/40 p-3 font-mono text-[11px] text-white/70">
                {JSON.stringify(mappings, null, 2)}
              </pre>
              <button
                type="button"
                disabled={saveLoading || !strategyId.trim()}
                onClick={() => void saveMappingsToStrategy()}
                className="mt-4 inline-flex w-full items-center justify-center gap-2 rounded-lg bg-emerald-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-emerald-500 disabled:opacity-40"
              >
                {saveLoading ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Save className="h-4 w-4" />
                )}
                Save mappings to strategy
              </button>
              {saveMessage ? (
                <p className="mt-2 text-xs text-white/60">{saveMessage}</p>
              ) : null}
            </div>
          </aside>
        </>
      ) : null}
    </div>
  );
}
