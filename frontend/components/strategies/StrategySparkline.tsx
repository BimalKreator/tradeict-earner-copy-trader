"use client";

import { Area, AreaChart, ResponsiveContainer, YAxis } from "recharts";

type Props = {
  values: number[];
  className?: string;
  /** Unique per card so gradient defs do not collide. */
  chartId?: string;
};

export function StrategySparkline({
  values,
  className = "",
  chartId = "spark",
}: Props) {
  if (values.length < 2) {
    return (
      <div className={`h-12 rounded-lg border border-gray-800 bg-gray-900/60 ${className}`} />
    );
  }

  const data = values.map((v, i) => ({ i, v }));
  const min = Math.min(...values);
  const max = Math.max(...values);
  const positive = values[values.length - 1]! >= values[0]!;
  const stroke = positive ? "#22c55e" : "#f87171";
  const fillId = `${chartId}-${positive ? "up" : "down"}`;

  return (
    <div className={`h-12 w-full ${className}`}>
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={data} margin={{ top: 4, right: 0, left: 0, bottom: 0 }}>
          <defs>
            <linearGradient id={fillId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={stroke} stopOpacity={0.35} />
              <stop offset="100%" stopColor={stroke} stopOpacity={0} />
            </linearGradient>
          </defs>
          <YAxis domain={[min, max]} hide />
          <Area
            type="monotone"
            dataKey="v"
            stroke={stroke}
            strokeWidth={1.5}
            fill={`url(#${fillId})`}
            isAnimationActive={false}
            dot={false}
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}
