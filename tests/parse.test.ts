import { describe, expect, it } from "vitest";
import { parseLine, toEpochMs } from "../src/parse.ts";

const VALID = {
  request_id: "r-1",
  timestamp: "2026-09-10T12:00:00Z",
  client_id: "acme",
  endpoint: "/v1/search",
  status_code: 200,
};

function line(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({ ...VALID, ...overrides });
}

/** Narrow to the invalid branch so the error list can be asserted. */
function invalidErrors(raw: string): string[] {
  const outcome = parseLine(raw, 1);
  if (outcome.kind !== "invalid") throw new Error(`expected invalid, got ${outcome.kind}`);
  return outcome.detail.errors;
}

describe("parseLine", () => {
  it("accepts a well-formed record", () => {
    const outcome = parseLine(line(), 7);
    expect(outcome.kind).toBe("ok");
    if (outcome.kind !== "ok") return;
    expect(outcome.record.request).toEqual(VALID);
    expect(outcome.record.line).toBe(7);
    expect(outcome.record.timestampMs).toBe(Date.parse("2026-09-10T12:00:00Z"));
  });

  it("keeps unknown extra fields out of the record without rejecting it", () => {
    const outcome = parseLine(line({ region: "us-east-1", latency_ms: 42 }), 1);
    expect(outcome.kind).toBe("ok");
    if (outcome.kind !== "ok") return;
    expect(outcome.record.request).toEqual(VALID);
  });

  it("treats a blank or whitespace-only line as skippable, not an error", () => {
    expect(parseLine("", 1).kind).toBe("blank");
    expect(parseLine("   \t ", 1).kind).toBe("blank");
  });

  it("reports unparsable JSON as malformed with a truncated echo", () => {
    const outcome = parseLine(`{"request_id": `, 12);
    expect(outcome.kind).toBe("malformed");
    if (outcome.kind !== "malformed") return;
    expect(outcome.detail.line).toBe(12);
    expect(outcome.detail.error).toMatch(/JSON/);
    expect(outcome.detail.raw).toBe(`{"request_id":`);
  });

  it("truncates a very long malformed line", () => {
    const outcome = parseLine("x".repeat(500), 1);
    expect(outcome.kind).toBe("malformed");
    if (outcome.kind !== "malformed") return;
    expect(outcome.detail.raw).toHaveLength(201);
    expect(outcome.detail.raw.endsWith("…")).toBe(true);
  });

  it("rejects JSON that is not an object", () => {
    expect(invalidErrors("[1,2,3]")).toEqual(["record: expected a JSON object, got array"]);
    expect(invalidErrors("null")).toEqual(["record: expected a JSON object, got null"]);
    expect(invalidErrors("42")).toEqual(["record: expected a JSON object, got number"]);
  });

  it("reports a missing field", () => {
    const raw = JSON.stringify({ ...VALID, client_id: undefined });
    expect(invalidErrors(raw)).toEqual(["client_id: missing"]);
  });

  it("reports a wrong-typed field", () => {
    expect(invalidErrors(line({ endpoint: 42 }))).toEqual([
      "endpoint: expected string, got number",
    ]);
    expect(invalidErrors(line({ status_code: "200" }))).toEqual([
      'status_code: expected an integer, got string "200"',
    ]);
    expect(invalidErrors(line({ status_code: 200.5 }))).toEqual([
      "status_code: expected an integer, got number",
    ]);
  });

  it("reports an out-of-range status code", () => {
    expect(invalidErrors(line({ status_code: 99 }))).toEqual([
      "status_code: expected 100-599, got 99",
    ]);
    expect(invalidErrors(line({ status_code: 600 }))).toEqual([
      "status_code: expected 100-599, got 600",
    ]);
  });

  it("reports an empty string as empty rather than missing", () => {
    expect(invalidErrors(line({ endpoint: "" }))).toEqual([
      "endpoint: expected a non-empty string",
    ]);
  });

  it("reports a timestamp that is not ISO-8601", () => {
    expect(invalidErrors(line({ timestamp: "March 5, 2026" }))).toEqual([
      'timestamp: expected an ISO-8601 date-time, got string "March 5, 2026"',
    ]);
  });

  it("collects every field error in one pass", () => {
    const raw = JSON.stringify({ request_id: "r-1", endpoint: 9, status_code: "oops" });
    expect(invalidErrors(raw)).toEqual([
      "timestamp: missing",
      "client_id: missing",
      "endpoint: expected string, got number",
      'status_code: expected an integer, got string "oops"',
    ]);
  });

  it("keeps request_id on an invalid record when it is usable", () => {
    const outcome = parseLine(line({ status_code: 7 }), 3);
    expect(outcome.kind).toBe("invalid");
    if (outcome.kind !== "invalid") return;
    expect(outcome.detail.request_id).toBe("r-1");
  });
});

describe("toEpochMs", () => {
  it("accepts the ISO-8601 shapes an API client is likely to emit", () => {
    expect(toEpochMs("2026-09-10T12:00:00Z")).toBe(Date.parse("2026-09-10T12:00:00Z"));
    expect(toEpochMs("2026-09-10T12:00:00.123Z")).toBe(Date.parse("2026-09-10T12:00:00.123Z"));
    expect(toEpochMs("2026-09-10T12:00:00+02:00")).toBe(Date.parse("2026-09-10T10:00:00Z"));
    expect(toEpochMs("2026-09-10T12:00:00+0200")).toBe(Date.parse("2026-09-10T10:00:00Z"));
  });

  it("reads a timezone-less timestamp as UTC so reports do not vary by machine", () => {
    expect(toEpochMs("2026-09-10T12:00:00")).toBe(Date.parse("2026-09-10T12:00:00Z"));
    expect(toEpochMs("2026-09-10 12:00:00")).toBe(Date.parse("2026-09-10T12:00:00Z"));
  });

  it("rejects non-ISO and impossible dates", () => {
    expect(toEpochMs("March 5, 2026")).toBeNull();
    expect(toEpochMs("2026-09-10")).toBeNull();
    expect(toEpochMs("2026-13-45T99:00:00Z")).toBeNull();
    expect(toEpochMs("")).toBeNull();
  });
});
