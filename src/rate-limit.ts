import { TokenBucket } from "./token-bucket.ts";
import type {
  RateLimitConfig,
  RateLimitSection,
  ThrottledRequest,
  ValidRecord,
  ViolatingClient,
} from "./types.ts";

interface ClientState {
  bucket: TokenBucket;
  total: number;
  withinLimit: number;
  throttled: number;
  firstThrottledAt: string | null;
  lastThrottledAt: string | null;
  samples: ThrottledRequest[];
}

/**
 * Replay the log through one bucket per client and label each request.
 *
 * Records are sorted by time first. A token bucket is only meaningful over
 * non-decreasing time, and real multi-client logs interleave — sorting makes
 * the report a property of the requests themselves rather than of the order
 * they happened to be written in.
 */
export function analyzeRateLimits(
  records: readonly ValidRecord[],
  config: RateLimitConfig,
  maxSamples: number,
): RateLimitSection {
  const ordered = [...records].sort(
    (a, b) => a.timestampMs - b.timestampMs || a.line - b.line,
  );

  const states = new Map<string, ClientState>();

  for (const { request, timestampMs } of ordered) {
    let state = states.get(request.client_id);
    if (state === undefined) {
      // Seed the bucket full at this client's own first request, so a client
      // is never charged for however long the log ran before it showed up.
      state = {
        bucket: new TokenBucket(config.capacity, config.refillPerSecond, timestampMs),
        total: 0,
        withinLimit: 0,
        throttled: 0,
        firstThrottledAt: null,
        lastThrottledAt: null,
        samples: [],
      };
      states.set(request.client_id, state);
    }

    state.total += 1;
    if (state.bucket.classify(timestampMs) === "within_limit") {
      state.withinLimit += 1;
      continue;
    }

    state.throttled += 1;
    state.firstThrottledAt ??= request.timestamp;
    state.lastThrottledAt = request.timestamp;
    if (state.samples.length < maxSamples) {
      state.samples.push({
        request_id: request.request_id,
        timestamp: request.timestamp,
        endpoint: request.endpoint,
      });
    }
  }

  const violating: ViolatingClient[] = [];
  let totalThrottled = 0;

  for (const [client_id, state] of states) {
    totalThrottled += state.throttled;
    if (state.throttled === 0) continue;
    violating.push({
      client_id,
      total_requests: state.total,
      within_limit: state.withinLimit,
      throttled_count: state.throttled,
      // Non-null by construction: throttled > 0 means both were assigned.
      first_throttled_at: state.firstThrottledAt as string,
      last_throttled_at: state.lastThrottledAt as string,
      throttled_requests: state.samples,
      truncated: state.throttled > state.samples.length,
    });
  }

  // Worst offenders first; client_id breaks ties so two runs diff cleanly.
  violating.sort(
    (a, b) =>
      b.throttled_count - a.throttled_count || a.client_id.localeCompare(b.client_id),
  );

  return {
    algorithm: "token_bucket",
    mode: "report_only",
    config: {
      scope: "client_id",
      capacity: config.capacity,
      refill_tokens_per_second: config.refillPerSecond,
      throttled_requests_consume_tokens: false,
    },
    violating_client_count: violating.length,
    total_throttled_requests: totalThrottled,
    violating_clients: violating,
  };
}
