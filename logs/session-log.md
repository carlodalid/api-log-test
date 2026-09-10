# Session Log — api-log-ingest

A running log of working sessions on this project. Newest session at the bottom.
Each entry records the **prompts given** and the **design decisions made, with the
reasoning behind them** — the things that are not recoverable from the code or the
git history later.

**To append:** add a new `## Session N — YYYY-MM-DD` heading at the end, following
the same section order.

---

## Session 1 — 2026-09-10

**Outcome:** greenfield project taken from empty directory to a working, tested CLI.
50 tests passing, `tsc --noEmit` clean.

### 1. Prompts

**1.1 — Opening prompt** (via `/plan`, ~14:35 local)

> This is the start of a simple project, an injestion script for logs coming from
> different API clients. The script will accept an input file (JSONL) and output a
> single JSON report through the console. Each line of the input will contain a
> single API request with required fields - request_id, timestamp, client_id,
> endpoint and status_code. These fields are all string typed except for the
> status_code. The output will mainly contain clients that violate the rate limiting
> algorithm, malformed inputs (unparsable JSONL), and request counts - total, per
> client, per endpoint. The rate limiting principle we will follow is a token bucket
> algorithm, start with reasonable capacity and refill rates.

Session settings for this work: model Opus 5, effort high.

**1.2 — Course correction** (rejecting the first plan, ~15:10 local)

> In this token bucket implementation, we don't actually deny the request, we
> identify which ones are throttled since this does reporting instead given the
> parameters of the algorithm.

This was the single most consequential input of the session. See §3.1.

**1.3 — Logging request** (~15:20 local)

> Can you create a running log with this session and have it in a separate folder
> /logs. Make sure to include everything from the start. Important parts of the logs
> are the prompts and the design decisions.

Interpreted as a project-relative `logs/` directory, not an absolute `/logs` system
path. Produced this file.

### 2. Clarifying questions and answers

Four questions were put to the user before planning. Three took the recommended
option; the runtime answer overrode the recommendation.

| Question | Recommendation offered | Answer given |
| --- | --- | --- |
| Language / runtime | Python 3, stdlib only | **Overridden:** "Use node (typescript) runtime and pnpm. Make sure to lock the versions in the package.json file." |
| Token bucket scope | Per `client_id` | Per `client_id` — one budget across all endpoints |
| Bad records | Separate `invalid` bucket | Separate bucket: `malformed` = unparsable JSON, `invalid` = parsed but failed schema |
| Violation detail | Per-client summary + offending requests | Per-client summary plus the list of offending request ids |

### 3. Design decisions

#### 3.1 Rate limiting is report-only *(the defining decision)*

Prompted by 1.2. The first plan draft framed the token bucket as an enforcement
gate — `tryConsume()`, "denied" requests, "allowed" counts. That was wrong for this
tool. The bucket runs **over traffic that was already served**, to answer "who would
have been throttled under these parameters". Nothing is denied, dropped, or filtered.

Consequences that flowed through the whole design:

- The bucket API is `classify(atMs): "within_limit" | "throttled"`, not
  `tryConsume(): boolean`. It labels; it does not gate.
- Vocabulary is `throttled` / `within_limit` throughout — never denied / rejected /
  allowed — in code, field names, prose and tests.
- **Throttled requests remain in every traffic count.** They were served, so a report
  that dropped them from `counts.by_client` / `by_endpoint` / `total_requests` would
  understate real traffic. There is a dedicated test asserting this, plus the
  invariant `within_limit + throttled_count === total_requests`.
- The report carries `"mode": "report_only"` so a downstream consumer cannot mistake
  the JSON for an enforcement log.

Saved to project memory (`rate-limiting-is-report-only`) so the framing survives into
later sessions.

#### 3.2 A throttled request does not consume a token

The bucket is empty by definition at that moment, and this is what a real enforcing
limiter would do — so the labels line up with what *would* have happened had the
limit been enforced. Surfaced in the report as
`"throttled_requests_consume_tokens": false` so the policy is explicit rather than
implied.

The alternative policy — charging throttled requests anyway, so a client that keeps
hammering digs a deeper hole — was deliberately **not** built. It is noted in the
README as the one line to change in `src/token-bucket.ts` if the team ever wants it.
Building both would have meant a config flag nobody had asked for.

#### 3.3 Records are sorted by `(timestamp, line)` before replay

A token bucket is only meaningful over non-decreasing time, and real multi-client
logs interleave. Sorting makes the report a property of *the requests* rather than of
the order they happened to be written in — the same requests always produce the same
report.

Rejected alternative: process in stream order and clamp backwards time to zero
elapsed. Cheaper in memory, but the answer would depend on how the file was written.

Accepted cost: parsed records accumulate in memory. The **file** is still streamed via
`readline`, so raw lines never all sit in memory at once. Documented in the README.

#### 3.4 Each client's bucket starts full at that client's own first request

A client that first appears an hour into the log is not charged for the hour it was
absent. Buckets are created lazily on first sight.

#### 3.5 Timezone-less timestamps are read as UTC

`Date.parse("2026-09-10T12:00:00")` uses *local* time, which would make the same input
file produce different violation reports on different machines. Reading them as UTC
makes the output machine-independent. Determinism matters more here than matching
JavaScript's default.

#### 3.6 Timestamps are shape-checked against an ISO-8601 regex before parsing

`Date.parse` alone accepts `"March 5, 2026"`, which is not something a well-behaved
API client should be emitting. The regex rejects it; `Date.parse` then catches
impossible dates that are ISO-shaped.

#### 3.7 Unknown extra fields are tolerated, not rejected

Client log shapes drift. Failing on an added field would turn a harmless rollout into
a wall of invalid records. Extra fields are ignored and kept out of the normalized
record.

#### 3.8 Every field error is collected in one pass

An invalid record reports *everything* wrong with it, not just the first failure, so
one run tells a client the full story.

#### 3.9 Output is built to diff cleanly

Two runs over the same file should differ only in `generated_at`:

- All count maps emit **sorted keys**.
- **All five status classes** (`1xx`–`5xx`) are always present, zeros included, rather
  than only those observed.
- `violating_clients` is sorted by `throttled_count` desc, ties broken by `client_id`.

There is an end-to-end test asserting byte-for-byte stability modulo the timestamp.

#### 3.10 `--max-samples` caps sample lists; counts always stay complete

Large files should not produce megabyte reports. Sample lists
(`throttled_requests`, `malformed_lines`, `invalid_records`) are capped at 50 by
default, and anything cut is marked with a `truncated` flag. The *counts* beside them
are never capped.

#### 3.11 Exit codes

`0` for any successful report — **including one full of violations**, since finding
violations is the tool working correctly. `1` only for usage or I/O failure. Report to
stdout, errors to stderr, so `| jq` always works.

#### 3.12 Defaults: capacity 10, refill 1 token/sec

60 sustained requests per minute with a burst allowance of 10. Both are overridable
and both are echoed into the report's `config` block, so a report is self-describing.

#### 3.13 Runtime: zero dependencies, no build step

Node 24 runs `.ts` files directly via native type stripping, so the CLI needs no
runtime dependencies and no build. `tsconfig.json` sets **`erasableSyntaxOnly`** so
`tsc` catches any syntax (enums, parameter properties, namespaces) that type stripping
could not run — the failure is caught at typecheck rather than at runtime.

Dev dependencies pinned **exactly**, per the user's instruction, verified against the
registry rather than guessed:

| Package | Version |
| --- | --- |
| typescript | 7.0.2 |
| @types/node | 24.13.4 |
| vitest | 5.0.0 |

Local toolchain: Node 24.18.0, pnpm 12.3.4 (recorded in `packageManager`).

#### 3.14 A float epsilon in the bucket

Fractional refill means a boundary case like "ten seconds at 0.1 tokens/sec" can land
a hair under 1.0 through no fault of the caller. Anything within `1e-9` of a whole
token counts as a whole token, so exact-boundary behaviour is predictable. Covered by
a test.

### 4. Implementation sequence

1. `package.json`, `tsconfig.json`, `.gitignore`; `pnpm install` (backgrounded).
2. `src/types.ts` — shared types including the full report shape.
3. `src/token-bucket.ts` — clockless bucket, caller supplies event time.
4. `src/parse.ts` — line → `ok` / `malformed` / `invalid` / `blank`.
5. `src/rate-limit.ts`, `src/aggregate.ts`, `src/report.ts`.
6. `src/cli.ts` — `node:util` `parseArgs`, streaming read, JSON to stdout.
7. `fixtures/sample.jsonl` — 31 lines, generated deterministically: clean traffic,
   a 15-request burst in one instant, out-of-order records, extra-field record, two
   unparsable lines, five schema failures, one blank line.
8. Four test files (50 tests), then `README.md`.

### 5. Issues hit

| Issue | Cause | Resolution |
| --- | --- | --- |
| 2 test failures on first run | Both were **test** bugs, not code bugs | See below |
| — shared `nextLine` counter | Module-level counter leaked across tests, so request ids were not 1..n within each test | Reset in `beforeEach` |
| — `--refill-rate -1` not rejected as expected | Node's `parseArgs` reports `-1` as an *ambiguous* option value, which is correct behaviour with a helpful message | Test uses the `=` form; the ambiguity message is now also asserted, and the `=` requirement is documented in the README |
| "no such file" printed `process.argv[2]` | Wrong file named when flags precede the path | Use the fs error's own `.path` |
| `pnpm install` created `pnpm-workspace.yaml` | `@types/node@24.13.4` is newer than pnpm's default minimum-release-age gate, so pnpm added a `minimumReleaseAgeExclude` entry | **Keep the file** — installs will not reproduce without it |

### 6. Final state

```
src/cli.ts          164 lines   arg parsing, streaming read, JSON to stdout
src/parse.ts        161         line → ok / malformed / invalid / blank
src/rate-limit.ts   112         sorted replay, one bucket per client_id
src/types.ts        117         shared types incl. report shape
src/token-bucket.ts  63         clockless bucket, classify()
src/aggregate.ts     62         counts by client / endpoint / status class
src/report.ts        52         report assembly
tests/              556         50 tests across 4 files
```

Verification: `pnpm typecheck` clean; `pnpm test` 50/50 passing; manual smoke covering
`| jq`, missing file (exit 1), no args (usage, exit 1), empty input file (exit 0, all
zeros), and a tighter budget flagging strictly more traffic.

On the fixture with default settings: 23 valid requests, 2 malformed lines, 5 invalid
records, 1 blank line skipped; one violating client (`burst-co`, 15 requests → 10
within limit, 5 throttled) whose 15 requests all still appear in the traffic counts.

### 7. Deliberately not built

- The alternative "throttled requests consume tokens" policy (§3.2).
- Per-`(client, endpoint)` bucket scope — considered and declined during clarification.
- Streaming rate-limit evaluation without the in-memory sort (§3.3).
- Git init / first commit — the directory is still not a git repository.

---

## Session 2 — 2026-09-10

**Outcome:** report output narrowed to the essentials. 48 tests passing (down from
50 — two suites were removed with the code they covered), `tsc --noEmit` clean.

### 1. Prompts

**2.1 — Simplify the report** (~15:30 local)

> Let's clean up the report output to make it simpler. The keys we wanna remove
> including their implementations - unique_clients, unique_endpoints, simplify counts
> object to just total_requests.

### 2. Design decisions

#### 2.1 Report surface narrowed to totals only

Removed from `summary`: `unique_clients`, `unique_endpoints`. Reduced `counts` from
four keys to one:

```jsonc
// before                              // after
"counts": {                            "counts": { "total_requests": 23 }
  "total_requests": 23,
  "by_client":       { ... },
  "by_endpoint":     { ... },
  "by_status_class": { ... }
}
```

This walks back part of the original brief in 1.1, which asked for "request counts -
total, per client, per endpoint". Flagged at the time and confirmed by the request, so
the narrower surface is the intended one.

Two consequences worth remembering, both raised before the change was made:

- **`by_client` was the only place non-violating clients appeared.** The report now
  names a client *only* if it was throttled. There is no longer any way to see the
  traffic shape of well-behaved clients.
- **`status_code` is now validated but never reported.** It is still required, still
  range-checked to `100`–`599`, and a bad value still lands the record in
  `invalid_records` — but it no longer surfaces anywhere in the output. Noted in the
  README so the field does not look vestigial.

#### 2.2 `src/aggregate.ts` deleted rather than hollowed out

With the breakdowns gone, `aggregate()` reduced to `records.length`, which does not
earn a module, an import and a test suite. The file was removed; `total_requests` is
computed inline in `buildReport`, and `timeRange()` — its only other export, still
needed for `summary.time_range` — moved into `src/report.ts`, its sole caller.

This supersedes Session 1 §3.9's "all count maps emit sorted keys" and "all five
status classes always present": there are no maps left to sort. Determinism of the
output now rests entirely on the `violating_clients` ordering, and the end-to-end
stability test still covers it.

#### 2.3 Tests removed with the code, not repointed at nothing

- The whole `describe("aggregate")` suite went with the module.
- The report-only invariant test that asserted throttled requests survive into
  `counts.by_client` / `by_endpoint` was **rewritten, not deleted** — it now asserts
  the same guarantee against the surviving surface (`client.total_requests` counts
  throttled requests, and `counts.total_requests` is 23 while 5 are flagged). That
  invariant is the point of the tool (Session 1 §3.1) and needed to keep a test.

### 3. Files touched

| File | Change |
| --- | --- |
| `src/types.ts` | `Counts` down to one key; `unique_*` off `Summary` |
| `src/report.ts` | Dropped `uniqueCount`; absorbed `timeRange`; inlined the total |
| `src/aggregate.ts` | **Deleted** |
| `tests/rate-limit.test.ts` | `aggregate` suite removed; invariant test rewritten |
| `tests/cli.test.ts` | `summary` and `counts` expectations updated |
| `README.md` | Output example, layout table, and the `status_code` note |

### 4. Final state

```
src/cli.ts          164 lines
src/parse.ts        161
src/types.ts        112
src/rate-limit.ts   112
src/report.ts        63
src/token-bucket.ts  63
tests/              520         48 tests across 4 files
```

Verification: `pnpm typecheck` clean; `pnpm test` 48/48 passing; report re-run against
the fixture and inspected; grepped for stale references to every removed key and to
`aggregate` — none remain in `src/`, `tests/` or `README.md`.
