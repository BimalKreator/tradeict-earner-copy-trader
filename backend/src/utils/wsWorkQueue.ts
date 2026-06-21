export type WsWorkPriority = "high" | "normal";

/**
 * Decouples WebSocket ingestion from async handler execution.
 * High-priority tasks (closes / flat hints) jump ahead of slow open fan-out work.
 */
export class WsWorkQueue {
  private readonly high: Array<() => Promise<void>> = [];
  private readonly normal: Array<() => Promise<void>> = [];
  private pumping = false;

  enqueue(priority: WsWorkPriority, task: () => Promise<void>): void {
    if (priority === "high") this.high.push(task);
    else this.normal.push(task);
    void this.pump();
  }

  private async pump(): Promise<void> {
    if (this.pumping) return;
    this.pumping = true;
    try {
      while (this.high.length > 0 || this.normal.length > 0) {
        const task = this.high.shift() ?? this.normal.shift();
        if (!task) break;
        try {
          await task();
        } catch (err) {
          console.error(
            "[ws-queue] task failed:",
            err instanceof Error ? err.message : err,
          );
        }
      }
    } finally {
      this.pumping = false;
      if (this.high.length > 0 || this.normal.length > 0) {
        void this.pump();
      }
    }
  }
}
