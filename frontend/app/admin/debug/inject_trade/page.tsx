import { redirect } from "next/navigation";

/** Legacy / mistyped URL — canonical path uses a hyphen. */
export default function AdminInjectTradeUnderscoreRedirect() {
  redirect("/admin/debug/inject-trade");
}
