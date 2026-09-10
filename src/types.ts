/**
 * Shared types for the ingestion pipeline.
 *
 * Naming note: this tool analyses traffic that has *already been served*. A
 * request is never denied or dropped — the token bucket only labels it
 * `within_limit` or `throttled`. Every valid request counts toward every total.
 */

/** A log line that passed schema validation. */
export interface ApiRequest {
  request_id: string;
  timestamp: string;
  client_id: string;
  endpoint: string;
  status_code: number;
}

/** A valid request plus the bookkeeping the pipeline needs. */
export interface ValidRecord {
  request: ApiRequest;
  /** `timestamp` resolved to epoch millis; timezone-less input is read as UTC. */
  timestampMs: number;
  /** 1-based line number in the source file. */
  line: number;
}

/** A line that is not parsable as JSON at all. */
export interface MalformedLine {
  line: number;
  error: string;
  raw: string;
}

/** A line that parsed as JSON but failed the record schema. */
export interface InvalidRecord {
  line: number;
  request_id: string | null;
  errors: string[];
  raw: string;
}

export type LineOutcome =
  | { kind: "blank" }
  | { kind: "ok"; record: ValidRecord }
  | { kind: "malformed"; detail: MalformedLine }
  | { kind: "invalid"; detail: InvalidRecord };

/** The bucket classifies; it does not gate. */
export type Verdict = "within_limit" | "throttled";

export interface RateLimitConfig {
  capacity: number;
  refillPerSecond: number;
}

export interface ThrottledRequest {
  request_id: string;
  timestamp: string;
  endpoint: string;
}

export interface ViolatingClient {
  client_id: string;
  total_requests: number;
  within_limit: number;
  throttled_count: number;
  first_throttled_at: string;
  last_throttled_at: string;
  /** Capped by --max-samples; `truncated` says whether anything was cut. */
  throttled_requests: ThrottledRequest[];
  truncated: boolean;
}

export interface RateLimitSection {
  algorithm: "token_bucket";
  /** Marks this JSON as analysis output, not an enforcement log. */
  mode: "report_only";
  config: {
    scope: "client_id";
    capacity: number;
    refill_tokens_per_second: number;
    throttled_requests_consume_tokens: false;
  };
  violating_client_count: number;
  total_throttled_requests: number;
  violating_clients: ViolatingClient[];
}

export interface Counts {
  total_requests: number;
  by_client: Record<string, number>;
  by_endpoint: Record<string, number>;
  by_status_class: Record<string, number>;
}

export interface Summary {
  total_lines: number;
  blank_lines: number;
  valid_requests: number;
  malformed_lines: number;
  invalid_records: number;
  unique_clients: number;
  unique_endpoints: number;
  time_range: { start: string | null; end: string | null };
}

export interface Report {
  generated_at: string;
  source: { file: string };
  summary: Summary;
  counts: Counts;
  rate_limiting: RateLimitSection;
  malformed_lines: MalformedLine[];
  malformed_lines_truncated: boolean;
  invalid_records: InvalidRecord[];
  invalid_records_truncated: boolean;
}
