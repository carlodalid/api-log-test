import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { beforeAll, describe, expect, it } from "vitest";
import type { Report } from "../src/types.ts";

const run = promisify(execFile);

const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const FIXTURE = fileURLToPath(new URL("../fixtures/sample.jsonl", import.meta.url));

interface Run {
  stdout: string;
  stderr: string;
  code: number;
}

async function cli(...args: string[]): Promise<Run> {
  try {
    const { stdout, stderr } = await run(process.execPath, [CLI, ...args]);
    return { stdout, stderr, code: 0 };
  } catch (error) {
    const failure = error as { stdout?: string; stderr?: string; code?: number };
    return { stdout: failure.stdout ?? "", stderr: failure.stderr ?? "", code: failure.code ?? 1 };
  }
}

describe("cli end to end", () => {
  let report: Report;
  let raw: string;

  beforeAll(async () => {
    const result = await cli(FIXTURE);
    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    raw = result.stdout;
    report = JSON.parse(raw) as Report;
  });

  it("writes nothing but a single JSON document to stdout", () => {
    expect(raw.startsWith("{")).toBe(true);
    expect(raw.trimEnd().endsWith("}")).toBe(true);
    expect(() => JSON.parse(raw)).not.toThrow();
  });

  it("summarizes the fixture", () => {
    expect(report.summary).toEqual({
      total_lines: 31,
      blank_lines: 1,
      valid_requests: 23,
      malformed_lines: 2,
      invalid_records: 5,
      unique_clients: 3,
      unique_endpoints: 3,
      time_range: { start: "2026-09-10T12:00:00Z", end: "2026-09-10T12:00:09Z" },
    });
  });

  it("counts all valid traffic, throttled requests included", () => {
    expect(report.counts).toEqual({
      total_requests: 23,
      by_client: { "burst-co": 15, "quiet-co": 3, "steady-co": 5 },
      by_endpoint: { "/v1/health": 3, "/v1/search": 15, "/v1/users": 5 },
      by_status_class: { "1xx": 0, "2xx": 16, "3xx": 1, "4xx": 5, "5xx": 1 },
    });
    // The bursty client's 15 requests all survive into the counts even though
    // five of them are flagged.
    expect(report.counts.by_client["burst-co"]).toBe(15);
  });

  it("flags only the bursty client", () => {
    expect(report.rate_limiting.mode).toBe("report_only");
    expect(report.rate_limiting.violating_client_count).toBe(1);
    expect(report.rate_limiting.total_throttled_requests).toBe(5);

    const client = report.rate_limiting.violating_clients[0]!;
    expect(client.client_id).toBe("burst-co");
    expect(client.total_requests).toBe(15);
    expect(client.within_limit).toBe(10);
    expect(client.throttled_count).toBe(5);
    expect(client.truncated).toBe(false);
    expect(client.throttled_requests.map((r) => r.request_id)).toEqual([
      "burst-11", "burst-12", "burst-13", "burst-14", "burst-15",
    ]);
  });

  it("separates unparsable lines from schema failures", () => {
    expect(report.malformed_lines.map((m) => m.line)).toEqual([25, 26]);
    expect(report.invalid_records.map((r) => r.line)).toEqual([27, 28, 29, 30, 31]);
    expect(report.invalid_records[0]!.errors).toEqual(["status_code: missing"]);
    expect(report.malformed_lines_truncated).toBe(false);
    expect(report.invalid_records_truncated).toBe(false);
  });

  it("is byte-for-byte stable across runs apart from the timestamp", () => {
    return cli(FIXTURE).then((second) => {
      const strip = (text: string) => text.replace(/"generated_at": "[^"]+"/, "");
      expect(strip(second.stdout)).toBe(strip(raw));
    });
  });

  it("honours --capacity and --refill-rate and echoes them back", async () => {
    const { stdout } = await cli(FIXTURE, "--capacity", "2", "--refill-rate", "0.5");
    const tighter = JSON.parse(stdout) as Report;
    expect(tighter.rate_limiting.config.capacity).toBe(2);
    expect(tighter.rate_limiting.config.refill_tokens_per_second).toBe(0.5);
    // A tighter budget can only flag more traffic, never less.
    expect(tighter.rate_limiting.total_throttled_requests).toBeGreaterThan(
      report.rate_limiting.total_throttled_requests,
    );
  });

  it("caps sample lists with --max-samples while keeping counts intact", async () => {
    const { stdout } = await cli(FIXTURE, "--max-samples", "2");
    const capped = JSON.parse(stdout) as Report;
    expect(capped.summary.invalid_records).toBe(5);
    expect(capped.invalid_records).toHaveLength(2);
    expect(capped.invalid_records_truncated).toBe(true);

    const client = capped.rate_limiting.violating_clients[0]!;
    expect(client.throttled_count).toBe(5);
    expect(client.throttled_requests).toHaveLength(2);
    expect(client.truncated).toBe(true);
  });

  it("emits one line with --compact", async () => {
    const { stdout } = await cli(FIXTURE, "--compact");
    expect(stdout.trimEnd().split("\n")).toHaveLength(1);
    expect(JSON.parse(stdout)).toBeTruthy();
  });

  it("exits 1 with usage when no input file is given", async () => {
    const result = await cli();
    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("missing <input.jsonl>");
    expect(result.stderr).toContain("Usage:");
  });

  it("exits 1 when the input file does not exist", async () => {
    const result = await cli("does-not-exist.jsonl");
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("no such file");
  });

  it("exits 1 on an unknown flag or a bad flag value", async () => {
    const unknown = await cli(FIXTURE, "--nope");
    expect(unknown.code).toBe(1);
    expect(unknown.stderr).toContain("Usage:");

    const bad = await cli(FIXTURE, "--capacity", "zero");
    expect(bad.code).toBe(1);
    expect(bad.stderr).toContain("--capacity expects a number");

    // A negative value needs the "=" form; parseArgs would otherwise read
    // "-1" as another flag, which it reports as ambiguous.
    const negative = await cli(FIXTURE, "--refill-rate=-1");
    expect(negative.code).toBe(1);
    expect(negative.stderr).toContain("--refill-rate must be greater than 0");

    const ambiguous = await cli(FIXTURE, "--refill-rate", "-1");
    expect(ambiguous.code).toBe(1);
    expect(ambiguous.stderr).toContain("ambiguous");
  });

  it("prints usage to stdout for --help", async () => {
    const result = await cli("--help");
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Usage:");
    expect(result.stdout).toContain("never denied or filtered out");
  });
});
