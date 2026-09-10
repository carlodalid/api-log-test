import { describe, expect, it } from "vitest";
import { TokenBucket } from "../src/token-bucket.ts";

const SECOND = 1000;

describe("TokenBucket", () => {
  it("admits a full burst then throttles the next request", () => {
    const bucket = new TokenBucket(3, 1, 0);
    expect(bucket.classify(0)).toBe("within_limit");
    expect(bucket.classify(0)).toBe("within_limit");
    expect(bucket.classify(0)).toBe("within_limit");
    expect(bucket.classify(0)).toBe("throttled");
  });

  it("returns to within_limit after one token has refilled", () => {
    const bucket = new TokenBucket(2, 1, 0);
    bucket.classify(0);
    bucket.classify(0);
    expect(bucket.classify(0)).toBe("throttled");
    expect(bucket.classify(999)).toBe("throttled");
    expect(bucket.classify(1 * SECOND)).toBe("within_limit");
  });

  it("does not spend a token on a throttled request", () => {
    const bucket = new TokenBucket(1, 1, 0);
    bucket.classify(0);
    expect(bucket.tokens).toBe(0);
    expect(bucket.classify(0)).toBe("throttled");
    expect(bucket.tokens).toBe(0);
  });

  it("caps refill at capacity over a long idle gap", () => {
    const bucket = new TokenBucket(5, 1, 0);
    bucket.classify(0);
    // An hour of idling must not bank 3600 tokens.
    bucket.classify(3600 * SECOND);
    expect(bucket.tokens).toBe(4);
  });

  it("grants nothing for a backwards timestamp", () => {
    const bucket = new TokenBucket(2, 1, 10 * SECOND);
    bucket.classify(10 * SECOND);
    bucket.classify(10 * SECOND);
    expect(bucket.classify(0)).toBe("throttled");
    expect(bucket.classify(5 * SECOND)).toBe("throttled");
    // Time only moves forward from the high-water mark.
    expect(bucket.classify(11 * SECOND)).toBe("within_limit");
  });

  it("handles fractional refill rates at the exact boundary", () => {
    const bucket = new TokenBucket(1, 0.1, 0);
    bucket.classify(0);
    expect(bucket.classify(9 * SECOND)).toBe("throttled");
    expect(bucket.classify(10 * SECOND)).toBe("within_limit");
  });

  it("rejects nonsensical configuration", () => {
    expect(() => new TokenBucket(0, 1, 0)).toThrow(RangeError);
    expect(() => new TokenBucket(-1, 1, 0)).toThrow(RangeError);
    expect(() => new TokenBucket(1, 0, 0)).toThrow(RangeError);
    expect(() => new TokenBucket(1, Number.NaN, 0)).toThrow(RangeError);
  });
});
