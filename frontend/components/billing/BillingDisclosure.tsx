import { REVENUE_SHARE_BILLING_RULE } from "@/lib/billingDisclosure";

type BillingDisclosureProps = {
  className?: string;
};

export function BillingDisclosure({ className = "text-sm text-white/55" }: BillingDisclosureProps) {
  return <p className={className}>{REVENUE_SHARE_BILLING_RULE}</p>;
}
