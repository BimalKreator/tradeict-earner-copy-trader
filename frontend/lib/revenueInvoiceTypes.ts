export type RevenueInvoiceRow = {
  id: string;
  periodYear: number;
  periodMonth: number;
  structuresClosed: number;
  realizedPnl: number;
  cumulativeRealizedPnl?: number;
  hwmBefore: number;
  hwmAfter: number;
  billableProfit: number;
  profitSharePct: number;
  commissionAmount: number;
  creditNoteAmount: number | null;
  collectibleAmount: number;
  amountInr: number | null;
  usdInrRate: number | null;
  dueDate: string | null;
  status: string;
};
