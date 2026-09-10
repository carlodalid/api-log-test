import type { Verdict } from "./types.ts";

/**
 * Tokens are fractional, so a boundary case like "exactly one second of refill
 * at 0.1 tokens/sec, ten times over" can land a hair under 1.0 through no fault
 * of the caller. Treat anything within this of a whole token as a whole token.
 */
const EPSILON = 1e-9;

/**
 * A token bucket that classifies requests instead of gating them.
 *
 * It carries no clock: the caller supplies each event's time, which is what
 * makes replaying a historical log meaningful (and the unit tests trivial).
 */
export class TokenBucket {
  readonly capacity: number;
  readonly refillPerSecond: number;

  #tokens: number;
  #lastMs: number;

  constructor(capacity: number, refillPerSecond: number, startMs: number) {
    if (!Number.isFinite(capacity) || capacity <= 0) {
      throw new RangeError(`capacity must be a positive number, got ${capacity}`);
    }
    if (!Number.isFinite(refillPerSecond) || refillPerSecond <= 0) {
      throw new RangeError(`refill rate must be a positive number, got ${refillPerSecond}`);
    }
    this.capacity = capacity;
    this.refillPerSecond = refillPerSecond;
    this.#tokens = capacity;
    this.#lastMs = startMs;
  }

  /** Tokens currently in the bucket, for tests and debugging. */
  get tokens(): number {
    return this.#tokens;
  }

  /**
   * Refill for the time elapsed since the last event, then label this request.
   *
   * A throttled request does NOT consume a token — the bucket is empty by
   * definition at that point, and this keeps the labels aligned with what a
   * real enforcing limiter would have done to the same traffic.
   */
  classify(atMs: number): Verdict {
    // Clamp elapsed time: a backwards timestamp must never mint tokens.
    const elapsedMs = Math.max(0, atMs - this.#lastMs);
    this.#lastMs = Math.max(this.#lastMs, atMs);
    this.#tokens = Math.min(
      this.capacity,
      this.#tokens + (elapsedMs / 1000) * this.refillPerSecond,
    );

    if (this.#tokens >= 1 - EPSILON) {
      this.#tokens = Math.max(0, this.#tokens - 1);
      return "within_limit";
    }
    return "throttled";
  }
}
