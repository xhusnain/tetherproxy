import { describe, it, expect } from "vitest";
import { ConnectionLimiter } from "../src/rateLimiter.js";

describe("ConnectionLimiter per-IP active cap", () => {
  it("rejects with 'per-ip cap' once an IP reaches maxPerIp active", () => {
    let t = 0;
    const lim = new ConnectionLimiter({
      maxTotal: 100,
      maxPerIp: 2,
      maxNewPerMin: 100,
      windowMs: 60000,
      now: () => t,
    });
    expect(lim.tryAcquire("1.1.1.1")).toEqual({ ok: true });
    expect(lim.tryAcquire("1.1.1.1")).toEqual({ ok: true });
    expect(lim.tryAcquire("1.1.1.1")).toEqual({
      ok: false,
      reason: "per-ip cap",
    });
    // A different IP is unaffected.
    expect(lim.tryAcquire("2.2.2.2")).toEqual({ ok: true });
  });

  it("release decrements active and frees a slot (never below 0)", () => {
    let t = 0;
    const lim = new ConnectionLimiter({
      maxTotal: 100,
      maxPerIp: 1,
      maxNewPerMin: 100,
      windowMs: 60000,
      now: () => t,
    });
    expect(lim.tryAcquire("1.1.1.1")).toEqual({ ok: true });
    expect(lim.tryAcquire("1.1.1.1")).toEqual({
      ok: false,
      reason: "per-ip cap",
    });
    lim.release("1.1.1.1");
    expect(lim.tryAcquire("1.1.1.1")).toEqual({ ok: true });
    // Extra releases must not underflow.
    lim.release("1.1.1.1");
    lim.release("1.1.1.1");
    lim.release("1.1.1.1");
    expect(lim.tryAcquire("1.1.1.1")).toEqual({ ok: true });
  });
});

describe("ConnectionLimiter global cap", () => {
  it("rejects with 'global cap' once total active reaches maxTotal", () => {
    let t = 0;
    const lim = new ConnectionLimiter({
      maxTotal: 2,
      maxPerIp: 100,
      maxNewPerMin: 100,
      windowMs: 60000,
      now: () => t,
    });
    expect(lim.tryAcquire("1.1.1.1")).toEqual({ ok: true });
    expect(lim.tryAcquire("2.2.2.2")).toEqual({ ok: true });
    expect(lim.tryAcquire("3.3.3.3")).toEqual({
      ok: false,
      reason: "global cap",
    });
    // Freeing a slot lets the next IP in.
    lim.release("1.1.1.1");
    expect(lim.tryAcquire("3.3.3.3")).toEqual({ ok: true });
  });
});

describe("ConnectionLimiter fixed-window rate limit", () => {
  it("rejects with 'rate limit' after maxNewPerMin in a window, then resets", () => {
    let t = 1000;
    const lim = new ConnectionLimiter({
      maxTotal: 100,
      maxPerIp: 100,
      maxNewPerMin: 2,
      windowMs: 60000,
      now: () => t,
    });
    // Two new connections allowed in the window...
    expect(lim.tryAcquire("1.1.1.1")).toEqual({ ok: true });
    expect(lim.tryAcquire("1.1.1.1")).toEqual({ ok: true });
    // ...the third is rate-limited even after the actives are released.
    lim.release("1.1.1.1");
    lim.release("1.1.1.1");
    expect(lim.tryAcquire("1.1.1.1")).toEqual({
      ok: false,
      reason: "rate limit",
    });
    // Advance the clock past windowMs: the window resets and new conns flow.
    t += 60000;
    expect(lim.tryAcquire("1.1.1.1")).toEqual({ ok: true });
  });
});
