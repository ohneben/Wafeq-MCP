import { describe, expect, it } from "vitest";
import { RateLimiter } from "../src/rateLimiter.js";

describe("RateLimiter", () => {
  it("lets a burst inside the window through without delay", async () => {
    const limiter = new RateLimiter(5, 1000);
    const start = Date.now();
    for (let i = 0; i < 5; i++) await limiter.acquire();
    expect(Date.now() - start).toBeLessThan(50);
  });

  it("holds the caller until the window frees a slot", async () => {
    const limiter = new RateLimiter(2, 120);
    const start = Date.now();
    for (let i = 0; i < 4; i++) await limiter.acquire();
    // Two extra requests need two more windows to open.
    expect(Date.now() - start).toBeGreaterThanOrEqual(100);
  });

  it("never over-fills the window under concurrency", async () => {
    const limiter = new RateLimiter(3, 200);
    const times: number[] = [];
    await Promise.all(
      Array.from({ length: 6 }, async () => {
        await limiter.acquire();
        times.push(Date.now());
      }),
    );
    const first = times.sort((a, b) => a - b);
    expect(first.length).toBe(6);
    // The fourth slot cannot open before the window has elapsed.
    expect(first[3] - first[0]).toBeGreaterThanOrEqual(150);
  });
});
