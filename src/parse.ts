import type { ApiRequest, LineOutcome } from "./types.ts";

/** How much of an offending line to echo back in a diagnostic. */
const MAX_RAW_LENGTH = 200;

/**
 * Shape check only — `Date.parse` alone would happily accept "March 5, 2026",
 * which is not something a well-behaved API client should be emitting.
 */
const ISO_8601 =
  /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?$/;

const HAS_TIMEZONE = /(?:Z|[+-]\d{2}:?\d{2})$/;

const MIN_STATUS = 100;
const MAX_STATUS = 599;

function truncate(raw: string): string {
  return raw.length <= MAX_RAW_LENGTH ? raw : `${raw.slice(0, MAX_RAW_LENGTH)}…`;
}

/** A human-readable type name for an error message. */
function describe(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "string") return `string ${JSON.stringify(value)}`;
  return typeof value;
}

function readString(
  source: Record<string, unknown>,
  field: string,
  errors: string[],
): string | null {
  const value = source[field];
  if (value === undefined) {
    errors.push(`${field}: missing`);
    return null;
  }
  if (typeof value !== "string") {
    errors.push(`${field}: expected string, got ${describe(value)}`);
    return null;
  }
  if (value.trim() === "") {
    errors.push(`${field}: expected a non-empty string`);
    return null;
  }
  return value;
}

/**
 * Resolve a timestamp to epoch millis.
 *
 * A timezone-less timestamp is read as UTC rather than local time: the same
 * input file must produce the same report on every machine that runs it.
 */
export function toEpochMs(timestamp: string): number | null {
  if (!ISO_8601.test(timestamp)) return null;
  const normalized = HAS_TIMEZONE.test(timestamp)
    ? timestamp.replace(" ", "T")
    : `${timestamp.replace(" ", "T")}Z`;
  const ms = Date.parse(normalized);
  return Number.isNaN(ms) ? null : ms;
}

function readStatusCode(source: Record<string, unknown>, errors: string[]): number | null {
  const value = source["status_code"];
  if (value === undefined) {
    errors.push("status_code: missing");
    return null;
  }
  if (typeof value !== "number" || !Number.isInteger(value)) {
    errors.push(`status_code: expected an integer, got ${describe(value)}`);
    return null;
  }
  if (value < MIN_STATUS || value > MAX_STATUS) {
    errors.push(`status_code: expected ${MIN_STATUS}-${MAX_STATUS}, got ${value}`);
    return null;
  }
  return value;
}

/**
 * Classify one line of the input file.
 *
 * Unknown extra fields are kept out of the report but never rejected — client
 * log shapes drift, and failing on an added field would turn a harmless rollout
 * into a wall of invalid records.
 */
export function parseLine(line: string, lineNumber: number): LineOutcome {
  const trimmed = line.trim();
  if (trimmed === "") return { kind: "blank" };

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (error) {
    return {
      kind: "malformed",
      detail: {
        line: lineNumber,
        error: error instanceof Error ? error.message : String(error),
        raw: truncate(trimmed),
      },
    };
  }

  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return {
      kind: "invalid",
      detail: {
        line: lineNumber,
        request_id: null,
        errors: [`record: expected a JSON object, got ${describe(parsed)}`],
        raw: truncate(trimmed),
      },
    };
  }

  const source = parsed as Record<string, unknown>;
  const errors: string[] = [];

  // Every field is checked before returning, so one pass tells the client
  // everything that is wrong with the record rather than just the first thing.
  const request_id = readString(source, "request_id", errors);
  const timestamp = readString(source, "timestamp", errors);
  const client_id = readString(source, "client_id", errors);
  const endpoint = readString(source, "endpoint", errors);
  const status_code = readStatusCode(source, errors);

  let timestampMs: number | null = null;
  if (timestamp !== null) {
    timestampMs = toEpochMs(timestamp);
    if (timestampMs === null) {
      errors.push(`timestamp: expected an ISO-8601 date-time, got ${describe(timestamp)}`);
    }
  }

  if (
    errors.length > 0 ||
    request_id === null ||
    timestamp === null ||
    client_id === null ||
    endpoint === null ||
    status_code === null ||
    timestampMs === null
  ) {
    return {
      kind: "invalid",
      detail: {
        line: lineNumber,
        request_id: request_id,
        errors,
        raw: truncate(trimmed),
      },
    };
  }

  const request: ApiRequest = { request_id, timestamp, client_id, endpoint, status_code };
  return { kind: "ok", record: { request, timestampMs, line: lineNumber } };
}
