import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { parseArgs } from "node:util";

import { parseLine } from "./parse.ts";
import { buildReport } from "./report.ts";
import type { InvalidRecord, MalformedLine, ValidRecord } from "./types.ts";

const DEFAULT_CAPACITY = 10;
const DEFAULT_REFILL_PER_SECOND = 1;
const DEFAULT_MAX_SAMPLES = 50;

const USAGE = `Usage: node src/cli.ts <input.jsonl> [options]

Reads a JSONL API request log and writes a single JSON report to stdout.

Options:
  --capacity <n>      Token bucket capacity, i.e. burst allowance (default: ${DEFAULT_CAPACITY})
  --refill-rate <n>   Tokens restored per second (default: ${DEFAULT_REFILL_PER_SECOND})
  --max-samples <n>   Max sample entries per diagnostic list (default: ${DEFAULT_MAX_SAMPLES})
  --compact           Emit the report on a single line instead of indented
  -h, --help          Show this message

The rate limit is evaluated per client_id over already-served traffic: requests
are labelled within_limit or throttled, never denied or filtered out.`;

/** Signals a bad invocation — reported as usage, not as a crash. */
class UsageError extends Error {}

interface ParsedValues {
  capacity?: string | undefined;
  "refill-rate"?: string | undefined;
  "max-samples"?: string | undefined;
  compact?: boolean | undefined;
  help?: boolean | undefined;
}

function parseNumber(raw: string, flag: string, { integer = false } = {}): number {
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    throw new UsageError(`${flag} expects a number, got "${raw}"`);
  }
  if (integer && !Number.isInteger(value)) {
    throw new UsageError(`${flag} expects an integer, got "${raw}"`);
  }
  return value;
}

function positive(value: number, flag: string): number {
  if (value <= 0) throw new UsageError(`${flag} must be greater than 0, got ${value}`);
  return value;
}

async function main(argv: string[]): Promise<number> {
  let values: ParsedValues;
  let positionals: string[];
  try {
    ({ values, positionals } = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        capacity: { type: "string" },
        "refill-rate": { type: "string" },
        "max-samples": { type: "string" },
        compact: { type: "boolean", default: false },
        help: { type: "boolean", short: "h", default: false },
      },
    }));
  } catch (error) {
    // An unknown flag or a missing flag value is a usage problem, not a crash.
    throw new UsageError(error instanceof Error ? error.message : String(error));
  }

  if (values.help) {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }

  if (positionals.length === 0) throw new UsageError("missing <input.jsonl> argument");
  if (positionals.length > 1) {
    throw new UsageError(`expected exactly one input file, got ${positionals.length}`);
  }
  const file = positionals[0] as string;

  const capacity = positive(
    values.capacity === undefined
      ? DEFAULT_CAPACITY
      : parseNumber(values.capacity, "--capacity"),
    "--capacity",
  );
  const refillPerSecond = positive(
    values["refill-rate"] === undefined
      ? DEFAULT_REFILL_PER_SECOND
      : parseNumber(values["refill-rate"], "--refill-rate"),
    "--refill-rate",
  );
  const maxSamples =
    values["max-samples"] === undefined
      ? DEFAULT_MAX_SAMPLES
      : parseNumber(values["max-samples"], "--max-samples", { integer: true });
  if (maxSamples < 0) {
    throw new UsageError(`--max-samples must be 0 or greater, got ${maxSamples}`);
  }

  const records: ValidRecord[] = [];
  const malformed: MalformedLine[] = [];
  const invalid: InvalidRecord[] = [];
  let totalLines = 0;
  let blankLines = 0;

  // Stream the file so raw lines are never all held in memory at once.
  const lines = createInterface({
    input: createReadStream(file, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });

  for await (const line of lines) {
    totalLines += 1;
    const outcome = parseLine(line, totalLines);
    switch (outcome.kind) {
      case "blank":
        blankLines += 1;
        break;
      case "ok":
        records.push(outcome.record);
        break;
      case "malformed":
        malformed.push(outcome.detail);
        break;
      case "invalid":
        invalid.push(outcome.detail);
        break;
    }
  }

  const report = buildReport({
    file,
    totalLines,
    blankLines,
    records,
    malformed,
    invalid,
    config: { capacity, refillPerSecond },
    maxSamples,
  });

  process.stdout.write(`${JSON.stringify(report, null, values.compact ? 0 : 2)}\n`);
  return 0;
}

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (error) {
  if (error instanceof UsageError) {
    process.stderr.write(`error: ${error.message}\n\n${USAGE}\n`);
  } else if (error instanceof Error && "code" in error && error.code === "ENOENT") {
    // fs errors carry the path they failed on, which beats guessing from argv.
    const path = "path" in error ? String(error.path) : "input file";
    process.stderr.write(`error: no such file: ${path}\n`);
  } else {
    process.stderr.write(`error: ${error instanceof Error ? error.message : String(error)}\n`);
  }
  process.exitCode = 1;
}
