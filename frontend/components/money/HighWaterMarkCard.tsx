"use client";

import { Loader2 } from "lucide-react";
import { fmtUsd, formatINRApprox } from "@/lib/currency";

const HWM_GAP_FILL = "rgba(251, 191, 36, 0.15)";
const HWM_GAP_BORDER = "rgba(251, 191, 36, 0.45)";
const CUMULATIVE_FILL = "rgba(52, 211, 153, 0.35)";
const HWM_MARKER = "#0A84FF";

type HighWaterMarkCardProps = {
  cumulativeRealized: number | null;
  highWaterMark: number | null;
  profitSharePct: number | null;
  loading?: boolean;
  hasData?: boolean;
};

function MoneyStack({ label, usd }: { label: string; usd: number }) {
  return (
    <div>
      <p className="text-xs uppercase tracking-wide text-white/45">{label}</p>
      <p className="mt-1 text-lg font-semibold tabular-nums text-white">{fmtUsd(usd)}</p>
      <p className="text-xs tabular-nums text-white/45">{formatINRApprox(usd)}</p>
    </div>
  );
}

export function HighWaterMarkCard({
  cumulativeRealized,
  highWaterMark,
  profitSharePct,
  loading = false,
  hasData = false,
}: HighWaterMarkCardProps) {
  if (loading) {
    return (
      <section className="rounded-xl border border-white/10 bg-white/[0.02] p-6">
        <div className="flex justify-center py-10">
          <Loader2 className="h-8 w-8 animate-spin text-white/30" />
        </div>
      </section>
    );
  }

  if (!hasData || cumulativeRealized == null || highWaterMark == null) {
    return (
      <section className="rounded-xl border border-white/10 bg-white/[0.02] p-6">
        <h2 className="text-lg font-medium text-white">Your profit &amp; fee-free zone</h2>
        <p className="mt-3 text-sm text-white/55">
          Your profit will appear here after the bot closes its first trade.
        </p>
      </section>
    );
  }

  const cumulative = cumulativeRealized;
  const hwm = highWaterMark;
  const gap = Math.max(0, hwm - cumulative);
  const sharePct =
    profitSharePct != null && Number.isFinite(profitSharePct) && profitSharePct > 0
      ? profitSharePct
      : null;

  const atNewBest = hwm > 0 && cumulative >= hwm;
  const inDrawdown = hwm > 0 && cumulative < hwm;
  const noProfitYet = hwm <= 0;

  const scaleMax = Math.max(hwm, cumulative, 1);
  const cumulativePct = Math.min(100, (cumulative / scaleMax) * 100);
  const hwmPct = Math.min(100, (hwm / scaleMax) * 100);

  return (
    <section className="rounded-xl border border-white/10 bg-white/[0.02] p-6 space-y-5">
      <h2 className="text-lg font-medium text-white">Your profit &amp; fee-free zone</h2>

      <div className="relative h-8 w-full overflow-hidden rounded-lg border border-white/10 bg-white/[0.03]">
        {inDrawdown ? (
          <>
            <div
              className="absolute inset-y-0 left-0"
              style={{ width: `${cumulativePct}%`, backgroundColor: CUMULATIVE_FILL }}
            />
            <div
              className="absolute inset-y-0"
              style={{
                left: `${cumulativePct}%`,
                width: `${Math.max(0, hwmPct - cumulativePct)}%`,
                backgroundColor: HWM_GAP_FILL,
                borderLeft: `1px solid ${HWM_GAP_BORDER}`,
              }}
            />
          </>
        ) : (
          <div
            className="absolute inset-y-0 left-0"
            style={{ width: `${cumulativePct}%`, backgroundColor: CUMULATIVE_FILL }}
          />
        )}
        {hwm > 0 ? (
          <div
            className="absolute inset-y-0 w-0.5"
            style={{ left: `${hwmPct}%`, backgroundColor: HWM_MARKER }}
            aria-hidden
          />
        ) : null}
      </div>

      <div className="space-y-4">
        <MoneyStack label="Total profit so far" usd={cumulative} />
        <MoneyStack label="Your best ever" usd={hwm} />
        {inDrawdown ? <MoneyStack label="Fee-free zone" usd={gap} /> : null}
      </div>

      <div className="space-y-2 border-t border-white/10 pt-4 text-sm leading-relaxed text-white/70">
        {atNewBest ? (
          <>
            <p className="text-base font-semibold text-white">You are at your best ever.</p>
            <p>
              Your total profit is {fmtUsd(cumulative)} — the highest it has ever been.
              {sharePct != null
                ? ` New profit from here is shared ${sharePct.toFixed(1)}% with us.`
                : " New profit from here is shared with us at your agreed rate."}{" "}
              Profit you already paid on is never charged again.
            </p>
          </>
        ) : null}

        {inDrawdown ? (
          <>
            <p className="text-base font-semibold text-white">
              You are {fmtUsd(gap)} below your best.
            </p>
            <p>
              Your best ever was {fmtUsd(hwm)}. Right now you are at {fmtUsd(cumulative)}.
            </p>
            <p className="text-base font-medium text-amber-200/95">
              You will not be charged anything until your profit crosses {fmtUsd(hwm)} again.
              Earning back this {fmtUsd(gap)} is free for you.
            </p>
          </>
        ) : null}

        {noProfitYet ? (
          <>
            <p className="text-base font-semibold text-white">No fee yet.</p>
            <p>
              You have not booked a profit so far, so there is nothing to charge. We only earn
              when you earn — and only on profit above your best-ever level.
            </p>
          </>
        ) : null}
      </div>
    </section>
  );
}
