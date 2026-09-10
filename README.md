# api-log-ingest

> **Note:** This project was created with [Claude Code](https://claude.com/claude-code). Session details are available in [`/logs`](./logs).

Reads a JSONL log of API requests and writes a single JSON report to stdout covering
traffic counts, bad input, and token-bucket rate-limit violations.

## Requirements

Node **>= 24** (the CLI runs TypeScript directly via native type stripping, so there
is no build step) and **pnpm**. Dev dependency versions are pinned exactly.

```sh
pnpm install
```

## Usage

```sh
node src/cli.ts <input.jsonl> [options]
```

| Option | Default | Meaning |
| --- | --- | --- |
| `--capacity <n>` | `10` | Token bucket capacity — the burst allowance |
| `--refill-rate <n>` | `1` | Tokens restored per second |
| `--max-samples <n>` | `50` | Cap on entries in each diagnostic list |
| `--compact` | off | One-line JSON instead of indented |
| `-h`, `--help` | | Show usage |

The defaults allow a burst of 10 and 60 sustained requests per minute. Flag values
that start with a dash need the `=` form (`--refill-rate=0.5`).

```sh
node src/cli.ts fixtures/sample.jsonl | jq .summary
node src/cli.ts fixtures/sample.jsonl --capacity 5 --refill-rate 0.5
```

Exit code is `0` for any successful report — including one full of violations — and
`1` for a usage or I/O failure. The report goes to stdout; errors go to stderr.

## Solution design

End-to-end, the CLI does the following:

1. **Stream** the input file line by line (`src/cli.ts`) — the file is never loaded
   into memory as a whole, so its size doesn't bound memory use.
2. **Parse & classify** each line (`src/parse.ts`) into one of four outcomes: `blank`,
   `ok` (valid record), `malformed` (not JSON at all), or `invalid` (JSON, but fails
   the record schema — see "Input format" below for the exact validation rules).
3. **Accumulate** valid records in memory, alongside running counts and the capped
   malformed/invalid sample lists.
4. **Sort** all valid records by `(timestamp, line number)` so replay happens in
   non-decreasing chronological order regardless of on-disk order (see
   "Assumptions and rate-limiting implementation" below for why this matters).
5. **Replay** the sorted records through one token bucket per `client_id`
   (`src/token-bucket.ts`, `src/rate-limit.ts`), labelling each request
   `within_limit` or `throttled`.
6. **Assemble** the final report object (`src/report.ts`) and write it to stdout as
   JSON (see "Output" below for the exact shape).

| Path | Role |
| --- | --- |
| `src/cli.ts` | Argument parsing, streaming file read, JSON to stdout |
| `src/parse.ts` | One line in, `ok` / `malformed` / `invalid` / `blank` out |
| `src/token-bucket.ts` | Clockless token bucket; `classify()`, not `tryConsume()` |
| `src/rate-limit.ts` | Replays sorted records through one bucket per client |
| `src/report.ts` | Assembles the final report object |
| `src/types.ts` | Shared types, including the report shape |
| `fixtures/sample.jsonl` | Clean, bursty, out-of-order, malformed and invalid lines |

## Input format

One JSON object per line, with all five fields required:

```json
{"request_id":"r-1","timestamp":"2026-09-10T12:00:00Z","client_id":"acme","endpoint":"/v1/search","status_code":200}
```

`request_id`, `timestamp`, `client_id` and `endpoint` are non-empty strings;
`status_code` is an integer in `100`–`599` — it is validated so that a bad value is
caught as an invalid record, but it does not otherwise appear in the report.
`timestamp` must be ISO-8601 — a
timestamp with no timezone is read as **UTC**, so the same file produces the same
report on every machine. Unknown extra fields are ignored rather than rejected;
client log shapes drift, and failing on an added field would turn a harmless
rollout into a wall of invalid records. Blank lines are skipped.

Bad lines are split into two buckets so transport corruption is distinguishable
from a client bug:

- `malformed_lines` — not parsable as JSON at all.
- `invalid_records` — parsed, but failed the schema. Every field is checked, so one
  pass reports everything wrong with the record rather than just the first thing.

Both carry the 1-based line number and a 200-character echo of the offending line.

## Assumptions and rate-limiting implementation

One of the main design decisions for this was to use token bucket rate limiting
for the following reason:
- The purpose of this script was mainly for reporting and we're not actually
denying any requests, rather we want to identify which client is hitting a specific
endpoint at an unreasonable rate given a certain time period

**This tool never denies anything.** It replays already-served traffic through a
token bucket to answer "who would have been throttled under these parameters".
Requests are labelled `within_limit` or `throttled`; a throttled request is still
counted in `counts.total_requests` and in its client's `total_requests`, because it
really was served. The report carries `"mode": "report_only"` so a downstream
consumer cannot mistake it for an enforcement log.

Details of the model:

- **One bucket per `client_id`**, shared across all of that client's endpoints.
- A client's bucket starts **full at that client's own first request**, so nobody is
  charged for however long the log ran before they showed up.
- **A throttled request does not consume a token** (`throttled_requests_consume_tokens:
  false` in the report). The bucket is empty by definition at that moment, and this
  keeps the labels aligned with what a real enforcing limiter would have done. If the
  team ever wants the harsher policy — charging throttled requests too, so a client
  that keeps hammering digs a deeper hole — that is the one line to change in
  `src/token-bucket.ts`.
- Records are **sorted by `(timestamp, line number)`** before replay. A bucket is only
  meaningful over non-decreasing time and real multi-client logs interleave, so
  sorting makes the report a property of the requests rather than of the order they
  happened to be written in. The cost is that valid records are held in memory; the
  file itself is streamed, so only the parsed records accumulate.
- A backwards timestamp never mints tokens, and idling never banks more than
  `capacity`.

Only clients with at least one throttled request appear in `violating_clients`
(worst first, ties broken by `client_id`). The report deliberately carries no
per-client or per-endpoint breakdown of all traffic — a client is named only if it
was throttled.

## Output

`violating_clients` is ordered deterministically, so two runs over the same file diff
cleanly — only `generated_at` changes. `--max-samples` caps
the length of the sample lists; counts always stay complete, and a `truncated` flag
marks any list that was cut.

```jsonc
{
  "generated_at": "2026-09-10T05:15:33.158Z",
  "source": { "file": "fixtures/sample.jsonl" },
  "summary": {
    "total_lines": 31, "blank_lines": 1, "valid_requests": 23,
    "malformed_lines": 2, "invalid_records": 5,
    "time_range": { "start": "2026-09-10T12:00:00Z", "end": "2026-09-10T12:00:09Z" }
  },
  "counts": { "total_requests": 23 },
  "rate_limiting": {
    "algorithm": "token_bucket",
    "mode": "report_only",
    "config": {
      "scope": "client_id", "capacity": 10, "refill_tokens_per_second": 1,
      "throttled_requests_consume_tokens": false
    },
    "violating_client_count": 1,
    "total_throttled_requests": 5,
    "violating_clients": [
      {
        "client_id": "burst-co",
        "total_requests": 15, "within_limit": 10, "throttled_count": 5,
        "first_throttled_at": "2026-09-10T12:00:00.000Z",
        "last_throttled_at": "2026-09-10T12:00:00.000Z",
        "throttled_requests": [
          { "request_id": "burst-11", "timestamp": "2026-09-10T12:00:00.000Z", "endpoint": "/v1/search" }
        ],
        "truncated": false
      }
    ]
  },
  "malformed_lines": [
    { "line": 26, "error": "Unexpected token 'o', \"not json at all\" is not valid JSON", "raw": "not json at all" }
  ],
  "malformed_lines_truncated": false,
  "invalid_records": [
    { "line": 27, "request_id": "missing-status", "errors": ["status_code: missing"], "raw": "..." }
  ],
  "invalid_records_truncated": false
}
```

## Development

```sh
pnpm typecheck   # tsc --noEmit
pnpm test        # vitest run
```

`tsconfig.json` sets `erasableSyntaxOnly`, so `tsc` catches any syntax (enums,
parameter properties, namespaces) that Node's type stripping could not run.
