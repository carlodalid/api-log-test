import type { Counts, ValidRecord } from "./types.ts";

/** Emitted for every run, present or not, so reports diff cleanly. */
const STATUS_CLASSES = ["1xx", "2xx", "3xx", "4xx", "5xx"] as const;

function statusClass(status: number): string {
  return `${Math.floor(status / 100)}xx`;
}

function bump(counter: Map<string, number>, key: string): void {
  counter.set(key, (counter.get(key) ?? 0) + 1);
}

/** Sort keys so the JSON output is stable across runs. */
function toSortedObject(counter: Map<string, number>): Record<string, number> {
  return Object.fromEntries(
    [...counter.entries()].sort(([a], [b]) => a.localeCompare(b)),
  );
}

/**
 * Count valid traffic.
 *
 * Throttled requests are included: they were served, and a report that dropped
 * them would understate what the API actually handled.
 */
export function aggregate(records: readonly ValidRecord[]): Counts {
  const byClient = new Map<string, number>();
  const byEndpoint = new Map<string, number>();
  const byStatusClass = new Map<string, number>(STATUS_CLASSES.map((key) => [key, 0]));

  for (const { request } of records) {
    bump(byClient, request.client_id);
    bump(byEndpoint, request.endpoint);
    bump(byStatusClass, statusClass(request.status_code));
  }

  return {
    total_requests: records.length,
    by_client: toSortedObject(byClient),
    by_endpoint: toSortedObject(byEndpoint),
    by_status_class: toSortedObject(byStatusClass),
  };
}

/** Earliest and latest request time, as they appeared in the input. */
export function timeRange(
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
