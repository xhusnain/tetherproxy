export interface ConnectionLimiterOptions {
  /** Maximum total active connections across all IPs. */
  maxTotal?: number;
  /** Maximum active connections from any single IP. */
  maxPerIp?: number;
  /** Maximum new connections per IP within one fixed window. */
  maxNewPerMin?: number;
  /** Fixed-window length in milliseconds. */
  windowMs?: number;
  /** Injectable monotonic-ish clock (defaults to Date.now). */
  now?: () => number;
}

export interface AcquireResult {
  ok: boolean;
  reason?: string;
}

interface IpState {
  /** Currently active connections from this IP. */
  active: number;
  /** New-connection count within the current window. */
  windowCount: number;
  /** Start timestamp (ms) of the current fixed window. */
  windowStart: number;
}

/**
 * Pure connection limiter for the proxy front end. Tracks global + per-IP
 * active connection counts and a fixed-window per-IP new-connection rate.
 * No timers and no I/O: the clock is injected so tests are deterministic.
 */
export class ConnectionLimiter {
  private readonly maxTotal: number;
  private readonly maxPerIp: number;
  private readonly maxNewPerMin: number;
  private readonly windowMs: number;
  private readonly now: () => number;
  private totalActive = 0;
  private readonly ips = new Map<string, IpState>();

  constructor(opts: ConnectionLimiterOptions = {}) {
    this.maxTotal = opts.maxTotal ?? 512;
    this.maxPerIp = opts.maxPerIp ?? 64;
    this.maxNewPerMin = opts.maxNewPerMin ?? 120;
    this.windowMs = opts.windowMs ?? 60000;
    this.now = opts.now ?? Date.now;
  }

  /**
   * Attempt to admit a new connection from `ip`. On success the global and
   * per-IP active counts are incremented and the caller MUST eventually call
   * release(ip). On failure nothing is mutated and a reason is returned.
   */
  tryAcquire(ip: string): AcquireResult {
    if (this.totalActive >= this.maxTotal) {
      return { ok: false, reason: "global cap" };
    }
    const state = this.getState(ip);
    if (state.active >= this.maxPerIp) {
      return { ok: false, reason: "per-ip cap" };
    }
    const t = this.now();
    if (t - state.windowStart >= this.windowMs) {
      state.windowStart = t;
      state.windowCount = 0;
    }
    if (state.windowCount >= this.maxNewPerMin) {
      return { ok: false, reason: "rate limit" };
    }
    state.active += 1;
    state.windowCount += 1;
    this.totalActive += 1;
    return { ok: true };
  }

  /** Release one active connection for `ip`. Never decrements below 0. */
  release(ip: string): void {
    const state = this.ips.get(ip);
    if (!state) return;
    if (state.active > 0) {
      state.active -= 1;
      if (this.totalActive > 0) this.totalActive -= 1;
    }
    // Drop fully-idle, expired entries to bound memory.
    if (state.active === 0 && this.now() - state.windowStart >= this.windowMs) {
      this.ips.delete(ip);
    }
  }

  private getState(ip: string): IpState {
    let state = this.ips.get(ip);
    if (!state) {
      state = { active: 0, windowCount: 0, windowStart: this.now() };
      this.ips.set(ip, state);
    }
    return state;
  }
}
