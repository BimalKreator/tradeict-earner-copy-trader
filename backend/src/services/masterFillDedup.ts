/**
 * Session-level dedup for master fill events across WS orders / user_trades channels.
 * Prevents the same master fill from fanning out twice when Delta emits both channels.
 *
 * Strategy (preserves copy-trading soul — fast live copy, REST still catches misses):
 * - user_trades (fills) is the primary live copy path when it arrives first.
 * - orders is the fallback when fills never arrive (UI/API-only order updates).
 * - Whichever channel copies first for an orderId blocks the other from copying.
 * - positions channel does NOT copy (tracker + UI cache only) — fills/orders copy; REST deficit sync covers gaps.
 */
export class MasterFillDedup {
  /** trade_id values already forwarded to follower copy pipeline. */
  private readonly seenTradeIds = new Set<string>();
  /** order_id copied via user_trades first — blocks orders-channel duplicate copy. */
  private readonly fillsCopiedOrderIds = new Set<string>();
  /** order_id copied via orders channel first — blocks fills-channel duplicate copy. */
  private readonly ordersCopiedOrderIds = new Set<string>();
  /** order_id → cumulative qty already sent to copy pipeline (orders-channel delta tracking). */
  private readonly orderPipelineCopied = new Map<string, number>();
  /** symbol:side → cumulative master lots already forwarded (all WS channels). */
  private readonly legPipelineCopied = new Map<string, number>();

  private legCopyKey(symbol: string, side: string): string {
    return `${symbol.trim().toUpperCase()}:${side.toUpperCase()}`;
  }

  /**
   * True when this master leg increment was already forwarded (orders/fills/positions).
   * Prevents double fan-out when Delta emits multiple channels for one fill.
   */
  shouldSkipLegCopy(args: {
    symbol: string;
    side: string;
    masterTotalLots: number;
  }): boolean {
    if (args.masterTotalLots <= 0) return true;
    const piped = this.legPipelineCopied.get(this.legCopyKey(args.symbol, args.side)) ?? 0;
    return piped >= args.masterTotalLots - 1e-9;
  }

  /** Record cumulative master lots forwarded to followers for this leg. */
  recordLegCopy(args: {
    symbol: string;
    side: string;
    masterTotalLots: number;
  }): void {
    if (args.masterTotalLots <= 0) return;
    const key = this.legCopyKey(args.symbol, args.side);
    const prev = this.legPipelineCopied.get(key) ?? 0;
    this.legPipelineCopied.set(key, Math.max(prev, args.masterTotalLots));
  }

  shouldSkipFillsChannelCopy(args: {
    tradeId: string;
    orderId: string | null;
  }): boolean {
    if (args.tradeId && this.seenTradeIds.has(args.tradeId)) {
      return true;
    }
    if (args.orderId && this.ordersCopiedOrderIds.has(args.orderId)) {
      if (args.tradeId) {
        this.seenTradeIds.add(args.tradeId);
      }
      return true;
    }
    return false;
  }

  recordFillsChannelCopy(args: {
    tradeId: string;
    orderId: string | null;
    qty: number;
  }): void {
    if (args.tradeId) {
      this.seenTradeIds.add(args.tradeId);
    }
    if (args.orderId) {
      this.fillsCopiedOrderIds.add(args.orderId);
      const prev = this.orderPipelineCopied.get(args.orderId) ?? 0;
      this.orderPipelineCopied.set(args.orderId, prev + args.qty);
    }
  }

  /**
   * Returns incremental qty to copy from an orders WS update, or null to skip fan-out.
   * Tracker-only updates should still run when this returns null.
   */
  resolveOrdersChannelCopy(args: {
    orderId: string | null;
    exchangeCumulative: number;
    fallbackIncrement: number;
  }): { qty: number; masterFillKey: string } | null {
    if (args.orderId && this.fillsCopiedOrderIds.has(args.orderId)) {
      return null;
    }

    if (args.orderId && args.exchangeCumulative > 0) {
      const piped = this.orderPipelineCopied.get(args.orderId) ?? 0;
      const delta = args.exchangeCumulative - piped;
      if (delta <= 0) {
        return null;
      }
      return {
        qty: delta,
        masterFillKey: `order:${args.orderId}:${args.exchangeCumulative}`,
      };
    }

    if (args.fallbackIncrement <= 0) {
      return null;
    }

    return {
      qty: args.fallbackIncrement,
      masterFillKey: `order-noid:${args.fallbackIncrement}`,
    };
  }

  recordOrdersChannelCopy(args: {
    orderId: string | null;
    qty: number;
    exchangeCumulative: number;
  }): void {
    if (args.orderId) {
      this.ordersCopiedOrderIds.add(args.orderId);
      if (args.exchangeCumulative > 0) {
        this.orderPipelineCopied.set(args.orderId, args.exchangeCumulative);
      } else {
        const prev = this.orderPipelineCopied.get(args.orderId) ?? 0;
        this.orderPipelineCopied.set(args.orderId, prev + args.qty);
      }
    }
  }
}
