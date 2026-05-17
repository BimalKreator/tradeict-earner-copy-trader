import { redirect } from "next/navigation";

export default function FundsRedirectPage() {
  redirect("/dashboard/payments");
}
