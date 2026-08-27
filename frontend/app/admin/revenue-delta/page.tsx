"use client";

import { AdminDeltaRevenueDashboard } from "@/components/admin/AdminDeltaRevenueDashboard";

/** Admin ops endpoints used by the Operations panel. */
const REVENUE_DELTA_OPS = {
  snapshot: "/admin/revenue/snapshot",
  invoice: "/admin/revenue/invoice",
  structurePnlRecompute: "/admin/structure-pnl/recompute",
  /** Typed confirmation when issue: true on POST revenue/invoice */
  issueConfirmation: "ISSUE INVOICE",
} as const;

export default function AdminRevenueDeltaPage() {
  return <AdminDeltaRevenueDashboard opsPaths={REVENUE_DELTA_OPS} />;
}
