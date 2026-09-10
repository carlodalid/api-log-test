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

/** Earliest and latest request time, as they appeared in the input. */
function timeRange(
  records: readonly ValidRecord[],
): { start: string | null; end: string | null } {
  let first: ValidRecord | undefined;
  let last: ValidRecord | undefined;

  for (const record of records) {
    if (first === undefined || record.timestampMs < first.timestampMs) first = record;
    if (last === undefined || record.timestampMs > last.timestampMs) last = record;
  }

  return {
    start: first?.request.timestamp ?? null,
    end: last?.request.timestamp ?? null,
  };
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
      time_range: timeRange(records),
    },
    counts: { total_requests: records.length },
    rate_limiting: analyzeRateLimits(records, input.config, maxSamples),
    malformed_lines: malformed.slice(0, maxSamples),
    malformed_lines_truncated: malformed.length > maxSamples,
    invalid_records: invalid.slice(0, maxSamples),
    invalid_records_truncated: invalid.length > maxSamples,
  };
}
