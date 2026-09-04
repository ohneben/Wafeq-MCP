/**
 * A tiny sliding-window rate limiter.
 *
 * Wafeq does not publish a numeric rate limit — its integration guide only says
 * that 429 is possible and to back off with the same idempotency key. So this
 * limiter defaults to a deliberately conservative ceiling rather than one derived
 * from a documented figure; raise it with WAFEQ_MAX_REQUESTS if your plan allows.
 * Retries on 429 (see client.ts) remain the backstop.
 *
 * The implementation keeps timestamps of recent requests in a window and, once the
 * window is full, awaits until the oldest ages out. JavaScript's single thread makes
 * the "check length, then record" step atomic (no `await` between them), so
 * concurrent callers can never over-fill the window.
 */
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export class RateLimiter {
  private readonly maxRequests: number;
  private readonly windowMs: number;
  private readonly timestamps: number[] = [];

  constructor(maxRequests: number, windowMs: number) {
    this.maxRequests = Math.max(1, Math.floor(maxRequests));
    this.windowMs = Math.max(1, Math.floor(windowMs));
  }

  /** Resolves as soon as a request slot is free, recording the request. */
  async acquire(): Promise<void> {
    for (;;) {
      const now = Date.now();
      const windowStart = now - this.windowMs;

      while (this.timestamps.length > 0 && this.timestamps[0] <= windowStart) {
        this.timestamps.shift();
      }

      if (this.timestamps.length < this.maxRequests) {
        this.timestamps.push(now);
        return;
      }

      const waitMs = this.timestamps[0] - windowStart;
      await sleep(Math.max(waitMs, 1));
    }
  }
}
