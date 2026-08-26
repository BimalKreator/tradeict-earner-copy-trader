/** Single source of truth for how profit-share billing works (HWM model).
 * Applies to strategies billed via the structure P&L / MonthlyRevenueInvoice
 * pipeline (bot strategies on Delta). Legacy Trade-row monthly invoices are
 * hard-disabled and must not be described by this promise.
 */
export const REVENUE_SHARE_BILLING_RULE =
  "On structure P&L (high-water mark) billing: you are charged only on profit above your previous best. A losing month reduces what is billable later — you never pay twice on the same profit.";
