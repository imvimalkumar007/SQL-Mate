# Query execution — removed in Phase 9

> **The query-execution module no longer exists.** Phase 9's UX overhaul
> removed the run-query path entirely. The app generates and validates SQL
> but does not execute it; users copy the validated SQL and run it in a
> tool of their choice (psql, DBeaver, DataGrip, etc.).

## Why this doc still exists

For archaeology. The original design had three Rust modules — extractor,
validator, **executor** — and four Tauri commands of which `execute_query`
ran the validated SQL in a read-only transaction with a row cap and
timeout. Phase 3 shipped that path; Phases 4 through 8 layered redaction
and provider abstraction on top of it.

Phase 9 dropped it for two reasons:

1. **Stronger security posture.** "We do not execute generated SQL" is a
   simpler claim than "we execute it in a read-only transaction with
   defense in depth." There is no execution code path inside the app at
   all — a buggy LLM, a hostile prompt-injection, and a software bug here
   all converge on the same outcome: a SQL string in the UI that does
   nothing until the user takes external action.
2. **User feedback.** The user testing Phase 8 explicitly asked for the
   button to be removed. Reading their preference as a signal about the
   product's audience: regulated data engineers already have SQL tools
   they trust; the "run in-app" affordance was not pulling weight.

## What still ships in service of T2

`SECURITY_MODEL.md` T2 (destructive SQL executed against the user's
database) used to depend on three layers: Rust pre-parse, sqlglot AST
walk in the Python sidecar, and the executor's read-only transaction +
row cap + timeout. With execution removed, the third layer is gone but
the first two still ship as defense in depth even though no execution
path consumes their verdict. They protect users in the case where the
displayed SQL would be destructive if copy-pasted into a SQL tool that
doesn't gate on read-only.

The schema-extraction code path still opens a database connection — for
the metadata-only `information_schema` query — but that is the only DB
connection the app opens. See `extract/postgres.rs` and `extract/mysql.rs`
for the verbatim queries; they are also reproduced in the security
review pack PDF.

## What was removed

For the historical record, removed in [phase-9 UX overhaul commits]:

- `commands::execute_query` Tauri command
- `execute_postgres` / `execute_mysql` per-dialect helpers
- `decode_pg_value` / `decode_mysql_value` row decoders
- `format_offset_dt` / `format_primitive_dt` time formatters
- `ExecutionResult` struct
- `ROW_CAP` (1,000) and `QUERY_TIMEOUT_MS` (30,000) constants
- `Store::update_history_execution` method (no caller left)
- `futures` crate dep (only used for `Stream::next` in the executor)
- The "Run query" button, results table, and CSV export affordances
  in the frontend

The `history` table still exists and is still written to at generation
time, but no longer carries `was_executed` / `execution_row_count` /
`execution_duration_ms` from real executions — those columns persist in
the schema for historical compatibility but only ever hold their default
values (0 / NULL / NULL) going forward.

## If execution is reintroduced later

The pattern in Phase 3 was sound: read-only transaction, row cap,
timeout, no row data leaving Rust except into the frontend display
state. If a future phase reintroduces it (e.g., for a power-user tier
that opts into in-app execution), the implementation should mirror what
was there — see git history for `commands::execute_postgres` /
`execute_mysql` at the merge of phase-9 for the working code.

The `sqlx` `time` / `uuid` features in `Cargo.toml` exist for that
hypothetical reintroduction. They were added in Phase 6.5 to let the
executor decode timestamp / UUID columns and stayed in the manifest
even after the decoders were deleted, because removing them would
require a Cargo.toml round-trip that's not worth doing for a feature
that may come back.
