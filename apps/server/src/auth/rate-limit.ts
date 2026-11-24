// 内存滑动窗口 + 递增退避限速器（覆盖初始化、账密登录、扫码绑定）。

interface Bucket {
  attempts: number[];
  failures: number;
  blockedUntil: number;
}

export interface RateLimitPolicy {
  windowMs: number;
  maxAttempts: number;
  baseBackoffMs: number;
  maxBackoffMs: number;
}

export const AUTH_LIMIT_POLICY: RateLimitPolicy = {
  windowMs: 60_000,
  maxAttempts: 10,
  baseBackoffMs: 2_000,
  maxBackoffMs: 5 * 60_000,
};

export const PAIR_LIMIT_POLICY: RateLimitPolicy = {
  windowMs: 60_000,
  maxAttempts: 6,
  baseBackoffMs: 5_000,
  maxBackoffMs: 10 * 60_000,
};

export class RateLimiter {
  private readonly buckets = new Map<string, Bucket>();
  private readonly policy: RateLimitPolicy;
  private readonly maxBuckets = 10_000;

  constructor(policy: RateLimitPolicy) {
    this.policy = policy;
  }

  private prune(nowMs: number): void {
    if (this.buckets.size < this.maxBuckets) return;
    for (const [k, b] of this.buckets) {
      const latest = b.attempts[b.attempts.length - 1] ?? 0;
      if (b.blockedUntil <= nowMs && nowMs - latest >= this.policy.windowMs) {
        this.buckets.delete(k);
      }
    }
    while (this.buckets.size >= this.maxBuckets) {
      const oldestKey = this.buckets.keys().next().value;
      if (oldestKey === undefined) break;
      this.buckets.delete(oldestKey);
    }
  }

  /** 检查是否处于退避/超限期；返回 null 表示放行，否则返回建议等待秒数。 */
  check(key: string, nowMs = Date.now()): number | null {
    const b = this.buckets.get(key);
    if (!b) return null;
    if (b.blockedUntil > nowMs) {
      return Math.max(1, Math.ceil((b.blockedUntil - nowMs) / 1000));
    }
    b.attempts = b.attempts.filter((t) => nowMs - t < this.policy.windowMs);
    if (b.attempts.length >= this.policy.maxAttempts) {
      const oldest = b.attempts[0] ?? nowMs;
      return Math.max(1, Math.ceil((oldest + this.policy.windowMs - nowMs) / 1000));
    }
    return null;
  }

  /** 记录一次尝试（无论成功与否都计入滑动窗口）。 */
  hit(key: string, nowMs = Date.now()): void {
    let b = this.buckets.get(key);
    if (!b) {
      this.prune(nowMs);
      b = { attempts: [], failures: 0, blockedUntil: 0 };
      this.buckets.set(key, b);
    }
    b.attempts = b.attempts.filter((t) => nowMs - t < this.policy.windowMs);
    b.attempts.push(nowMs);
  }

  /** 记录认证失败，触发指数退避。 */
  fail(key: string, nowMs = Date.now()): void {
    this.hit(key, nowMs);
    const b = this.buckets.get(key)!;
    b.failures += 1;
    if (b.failures >= 5) {
      const shift = Math.min(8, b.failures - 5);
      const wait = Math.min(this.policy.maxBackoffMs, this.policy.baseBackoffMs * (1 << shift));
      b.blockedUntil = Math.max(b.blockedUntil, nowMs + wait);
    }
  }

  /** 认证成功后重置失败退避计数。 */
  succeed(key: string): void {
    const b = this.buckets.get(key);
    if (!b) return;
    b.failures = 0;
    b.blockedUntil = 0;
  }
}
