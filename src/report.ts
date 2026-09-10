import { aggregate, timeRange } from "./aggregate.ts";
import { analyzeRateLimits } from "./rate-limit.ts";
import type {
  InvalidRecord,
  MalformedLine,
  RateLimitConfig,
  Report,
  ValidRecord,
} from "./types.ts";

export interface ReportInput {
  file: string;
  totalLines: number;
  blankLines: number;
  records: ValidRecord[];
  malformed: MalformedLine[];
  invalid: InvalidRecord[];
  config: RateLimitConfig;
  maxSamples: number;
  /** Injectable so tests can assert a fixed report. */
  generatedAt?: Date;
}

function uniqueCount<T>(records: readonly ValidRecord[], pick: (r: ValidRecord) => T): number {
  return new Set(records.map(pick)).size;
}

/** Assemble the final report. Counts stay complete even when samples are cut. */
export function buildReport(input: ReportInput): Report {
  const { records, malformed, invalid, maxSamples } = input;

  return {
    generated_at: (input.generatedAt ?? new Date()).toISOString(),
    source: { file: input.file },
    summary: {
      total_lines: input.totalLines,
      blank_lines: input.blankLines,
      valid_requests: records.length,
      malformed_lines: malformed.length,
      invalid_records: invalid.length,
      unique_clients: uniqueCount(records, (r) => r.request.client_id),
      unique_endpoints: uniqueCount(records, (r) => r.request.endpoint),
      time_range: timeRange(records),
    },
    counts: aggregate(records),
    rate_limiting: analyzeRateLimits(records, input.config, maxSamples),
    malformed_lines: malformed.slice(0, maxSamples),
    malformed_lines_truncated: malformed.length > maxSamples,
    invalid_records: invalid.slice(0, maxSamples),
    invalid_records_truncated: invalid.length > maxSamples,
  };
}
