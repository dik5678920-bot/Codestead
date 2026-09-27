const MAX_BACKOFF_MS = 3_600_000;

/**
 * Tracks when an in-worker scheduler may run next. A scheduler failure (a
 * thrown error or failed candidates) doubles the wait up to one hour so a
 * persistent bad state is retried slowly instead of every poll, while mail
 * dispatch in the same loop keeps running.
 */
export class SchedulerBackoff {
  private lastRunAt = Number.NEGATIVE_INFINITY;
  private failureStreak = 0;

  constructor(private readonly intervalMs: number) {}

  due(now: number) {
    return now - this.lastRunAt >= this.currentDelayMs();
  }

  currentDelayMs() {
    return Math.min(
      this.intervalMs * 2 ** Math.min(this.failureStreak, 16),
      Math.max(MAX_BACKOFF_MS, this.intervalMs),
    );
  }

  record(now: number, succeeded: boolean) {
    this.lastRunAt = now;
    this.failureStreak = succeeded ? 0 : this.failureStreak + 1;
  }
}
