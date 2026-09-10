import { beforeEach, describe, expect, it } from "vitest";
import { aggregate } from "../src/aggregate.ts";
import { analyzeRateLimits } from "../src/rate-limit.ts";
import type { RateLimitConfig, ValidRecord } from "../src/types.ts";

const CONFIG: RateLimitConfig = { capacity: 3, refillPerSecond: 1 };
const MANY_SAMPLES = 100;

let nextLine = 0;

// Reset per test so request ids are predictable within each one.
beforeEach(() => {
  nextLine = 0;
});

function record(client_id: string, isoTimestamp: string, endpoint = "/v1/search"): ValidRecord {
  nextLine += 1;
  return {
    request: {
      request_id: `r-${nextLine}`,
      timestamp: isoTimestamp,
      client_id,
      endpoint,
      status_code: 200,
    },
    timestampMs: Date.parse(isoTimestamp),
    line: nextLine,
  };
}

/** n requests from one client, all in the same instant. */
function burst(client_id: string, isoTimestamp: string, n: number): ValidRecord[] {
  return Array.from({ length: n }, () => record(client_id, isoTimestamp));
}

describe("analyzeRateLimits", () => {
  it("reports no violations for traffic inside the budget", () => {
    const records = burst("acme", "2026-01-01T00:00:00Z", 3);
    const result = analyzeRateLimits(records, CONFIG, MANY_SAMPLES);
    expect(result.violating_clients).toEqual([]);
    expect(result.violating_client_count).toBe(0);
    expect(result.total_throttled_requests).toBe(0);
  });

  it("labels the requests past the burst allowance as throttled", () => {
    const records = burst("acme", "2026-01-01T00:00:00Z", 5);
    const result = analyzeRateLimits(records, CONFIG, MANY_SAMPLES);
    expect(result.violating_clients).toHaveLength(1);
    const client = result.violating_clients[0]!;
    expect(client.total_requests).toBe(5);
    expect(client.within_limit).toBe(3);
    expect(client.throttled_count).toBe(2);
    expect(client.throttled_requests.map((r) => r.request_id)).toEqual(["r-4", "r-5"]);
  });

  it("accounts for every request: within_limit + throttled === total", () => {
    const records = [...burst("acme", "2026-01-01T00:00:00Z", 9)];
    const result = analyzeRateLimits(records, CONFIG, MANY_SAMPLES);
    for (const client of result.violating_clients) {
      expect(client.within_limit + client.throttled_count).toBe(client.total_requests);
    }
  });

  it("leaves throttled requests in the traffic counts — nothing is filtered out", () => {
    const records = burst("acme", "2026-01-01T00:00:00Z", 5);
    const result = analyzeRateLimits(records, CONFIG, MANY_SAMPLES);
    const counts = aggregate(records);

    expect(result.violating_clients[0]!.throttled_count).toBe(2);
    expect(counts.total_requests).toBe(5);
    expect(counts.by_client["acme"]).toBe(5);
    expect(counts.by_endpoint["/v1/search"]).toBe(5);
  });

  it("declares itself report-only", () => {
    const result = analyzeRateLimits([], CONFIG, MANY_SAMPLES);
    expect(result.mode).toBe("report_only");
    expect(result.config.throttled_requests_consume_tokens).toBe(false);
  });

  it("gives each client its own budget", () => {
    const records = [
      ...burst("acme", "2026-01-01T00:00:00Z", 3),
      ...burst("globex", "2026-01-01T00:00:00Z", 3),
    ];
    expect(analyzeRateLimits(records, CONFIG, MANY_SAMPLES).violating_clients).toEqual([]);
  });

  it("does not penalize a client for traffic that predates its first request", () => {
    const records = [
      ...burst("early", "2026-01-01T00:00:00Z", 3),
      ...burst("latecomer", "2026-01-01T01:00:00Z", 3),
    ];
    expect(analyzeRateLimits(records, CONFIG, MANY_SAMPLES).violating_clients).toEqual([]);
  });

  it("produces the same result whatever order the file was written in", () => {
    const shuffled = [
      record("acme", "2026-01-01T00:00:04Z"),
      record("acme", "2026-01-01T00:00:00Z"),
      record("acme", "2026-01-01T00:00:00Z"),
      record("acme", "2026-01-01T00:00:02Z"),
      record("acme", "2026-01-01T00:00:00Z"),
      record("acme", "2026-01-01T00:00:00Z"),
    ];
    const chronological = [...shuffled].sort((a, b) => a.timestampMs - b.timestampMs);

    const fromShuffled = analyzeRateLimits(shuffled, CONFIG, MANY_SAMPLES);
    const fromSorted = analyzeRateLimits(chronological, CONFIG, MANY_SAMPLES);

    expect(fromShuffled.total_throttled_requests).toBe(1);
    expect(fromShuffled.violating_clients.map((c) => c.throttled_count)).toEqual(
      fromSorted.violating_clients.map((c) => c.throttled_count),
    );
  });

  it("refills over time, so spread-out traffic stays within limit", () => {
    const records = Array.from({ length: 10 }, (_, i) =>
      record("acme", `2026-01-01T00:00:${String(i * 2).padStart(2, "0")}Z`),
    );
    expect(analyzeRateLimits(records, CONFIG, MANY_SAMPLES).violating_clients).toEqual([]);
  });

  it("ranks the worst offender first and breaks ties by client_id", () => {
    const records = [
      ...burst("bbb", "2026-01-01T00:00:00Z", 5),
      ...burst("aaa", "2026-01-01T00:00:00Z", 5),
      ...burst("ccc", "2026-01-01T00:00:00Z", 8),
    ];
    const result = analyzeRateLimits(records, CONFIG, MANY_SAMPLES);
    expect(result.violating_clients.map((c) => c.client_id)).toEqual(["ccc", "aaa", "bbb"]);
    expect(result.violating_client_count).toBe(3);
    expect(result.total_throttled_requests).toBe(2 + 2 + 5);
  });

  it("caps samples but keeps the counts complete", () => {
    const records = burst("acme", "2026-01-01T00:00:00Z", 20);
    const client = analyzeRateLimits(records, CONFIG, 2).violating_clients[0]!;
    expect(client.throttled_count).toBe(17);
    expect(client.throttled_requests).toHaveLength(2);
    expect(client.truncated).toBe(true);
  });

  it("records the first and last time a client was throttled", () => {
    const records = [
      ...burst("acme", "2026-01-01T00:00:00Z", 5),
      ...burst("acme", "2026-01-01T00:00:01Z", 3),
    ];
    const client = analyzeRateLimits(records, CONFIG, MANY_SAMPLES).violating_clients[0]!;
    expect(client.first_throttled_at).toBe("2026-01-01T00:00:00Z");
    expect(client.last_throttled_at).toBe("2026-01-01T00:00:01Z");
  });
});

describe("aggregate", () => {
  it("counts by client, endpoint and status class with sorted keys", () => {
    const records = [
      record("zeta", "2026-01-01T00:00:00Z", "/v1/z"),
      record("alpha", "2026-01-01T00:00:00Z", "/v1/a"),
      record("alpha", "2026-01-01T00:00:00Z", "/v1/a"),
    ];
    records[0]!.request.status_code = 503;
    records[1]!.request.status_code = 404;

    const counts = aggregate(records);
    expect(Object.keys(counts.by_client)).toEqual(["alpha", "zeta"]);
    expect(counts.by_client).toEqual({ alpha: 2, zeta: 1 });
    expect(counts.by_endpoint).toEqual({ "/v1/a": 2, "/v1/z": 1 });
    expect(counts.by_status_class).toEqual({ "1xx": 0, "2xx": 1, "3xx": 0, "4xx": 1, "5xx": 1 });
    expect(counts.total_requests).toBe(3);
  });

  it("emits every status class even when the log has none of them", () => {
    expect(aggregate([]).by_status_class).toEqual({
      "1xx": 0, "2xx": 0, "3xx": 0, "4xx": 0, "5xx": 0,
    });
  });
});
