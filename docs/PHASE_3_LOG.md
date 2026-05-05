# Phase 3 build log

What happened building Phase 3: SQL validation via the Python `sqlglot`
sidecar, query execution in a read-only transaction with a row cap and
timeout, and the UI surfaces for both. Captured for the next session, for
security review of the validator surface, and so the cross-language tooling
quirks don't catch the next person off-guard.

## Outcome

Phase 3 is complete on Windows. The Tauri app boots, spawns a Python sidecar
on startup, and the sidecar validates every generated query against the
extracted schema before the UI offers a Run button. Clicking Run opens a
read-only `sqlx` transaction, executes up to the row cap, and renders results
in a table. Validation is enforced at three layers per `docs/architecture/sql-validation.md`:

- **Layer 1** — Rust string-level pre-parse rejects anything that isn't `SELECT`/`WITH`-leading or contains a forbidden mutating token.
- **Layer 2** — Python sidecar with `sqlglot==30.7.0` parses, walks the AST, and rejects mutating nodes, system tables, denylisted functions, and unknown table/column references.
- **Layer 3** — UI never auto-runs; user clicks **Run query** after reviewing the SQL.

## Done-when criteria

| Criterion | Status |
|---|---|
| Full loop: connect → extract → ask → see SQL → validate → run → see results | ✓ end-to-end on the local Postgres 17.9 instance |
| No row data on the LLM call path | ✓ unchanged from Phase 2: only schema metadata + question |
| Validator rejects all non-`SELECT` statements in tests | ✓ 13 in-process Python tests passing (positive + 10 categories of negative) |

The 13-case test suite covers: ping, positive simple SELECT, positive JOIN with GROUP BY, top-level DROP rejection, top-level INSERT rejection, DELETE-inside-CTE rejection, multi-statement (`SELECT 1; DROP TABLE …`) rejection, `information_schema` rejection, unknown-table rejection, denylisted function (`pg_read_file`) rejection, `SELECT … INTO` rejection, empty input rejection, unknown column on aliased table rejection.

## Commits on `phase-3/validation-and-execution`

1. `phase-3: python sidecar with sqlglot validator, adr 0009`
2. `phase-3: rust sidecar manager with mpsc channel and restart-on-crash`
3. `phase-3: validate_sql + execute_query + run-button ui with results grid`
4. (this log + ROADMAP update)

## Decisions made (not warranting full ADRs, but worth recording)

- **Layer 1 implementation.** Rust-side keyword scan is deliberately conservative: must start with `SELECT` or `WITH` (case-insensitive, leading whitespace ignored), and any of ~22 forbidden-mutating keywords appearing as standalone alphabetic tokens triggers rejection. False positives are acceptable; layer 2 catches the corner cases.
- **No comment stripping in Layer 1.** A query like `/* DROP */ SELECT 1` would still pass Layer 1 (correctly — it really is a SELECT), and Layer 2 confirms the AST. Stripping comments in Rust would mean shipping a SQL tokenizer for no benefit; layer 2 already handles them.
- **Schema sent per request.** The sidecar receives the full canonical schema as JSON with every `validate` request. Schemas are small (~50 KB for 100 tables) and this avoids a sidecar-side cache + invalidation logic. Phase 5 may revisit if validation becomes a bottleneck on 200-table schemas; for Phase 3 it's cheap.
- **Best-effort column resolution.** Only fully qualified column references (`table.column` or `alias.column`) are checked against the schema. Unqualified references pass for now. The validator AST walker would need a proper scope tracker (with from-clauses, joins, subquery name resolution) to handle unqualified references; that's a Phase 7 follow-up.
- **`postgres` is the only dialect Phase 3 advertises.** The validator is dialect-aware — sqlglot supports MySQL/SQL Server/SQLite/Snowflake/BigQuery — but the executor and UI only know Postgres. Other dialects land in Phase 6.
- **`SET default_transaction_read_only = on`** issued before each query alongside `SET statement_timeout = 30000`. Defense in depth on top of the user-configured read-only role and the validator.
- **Row-cap behavior.** Default 1000 rows. `truncated: true` flag returned when hit; UI shows "(truncated)" next to the row count. Not yet user-configurable; that's the kind of polish that lives in a settings screen we don't have yet.
- **Fresh `sqlx::PgConnection` per execute.** No connection pool. The dev machine is single-user and queries are user-paced. Phase 5+ can revisit if the latency becomes annoying.
- **No history insert.** The `history` table exists in the schema-store migration from Phase 2, but Phase 3 doesn't write to it. Question/SQL/result-count tracking lands when there's a UI surface to consume it (probably Phase 7's "previous queries" panel).
- **Generic value decoder.** The execute path tries `Option<i64>`, `Option<i32>`, `Option<bool>`, `Option<f64>`, `Option<f32>`, `Option<String>` in order; falls back to `<unsupported type: TYPENAME>` for everything else. **Notable consequence:** `TIMESTAMPTZ`, `DATE`, `NUMERIC`, `JSONB`, `UUID` show as `<unsupported type: …>` until we enable the `time`/`uuid`/`bigdecimal` features on `sqlx`. Tradeoff was a 2–5 minute incremental rebuild vs. accepting the limitation; deferred. Documented in PHASE_3_LOG so the next person doesn't waste an hour wondering.

## Issues encountered and resolutions

### sqlglot 30 renamed AST node types

First sidecar boot crashed at import: `module 'sqlglot.expressions' has no attribute 'AlterTable'`. sqlglot 30 renamed the top-level alter node from `AlterTable` to plain `Alter` (keeping `AlterColumn` as a sub-node). Fixed by introspecting the actual exported names and updating the forbidden-node-types tuple. Took ~5 minutes — would have taken longer if the test had said "validation passes erroneously" instead of crashing on import.

### PowerShell pipe encoding mangled the JSON

Smoke-testing the sidecar via `'{"id":"t1","kind":"ping"}' | & python main.py` produced `parse_error: Expecting value: line 1 column 1 (char 0)`. The handshake printed correctly, so the sidecar was alive — but PowerShell's pipeline encoding (`$OutputEncoding` defaults to OEM/cp1252 on PS 5.1) was wrapping the JSON in a way Python's stdin couldn't decode. Bypassed the issue entirely by writing a Python test harness that imports `main` and calls `_handle()` directly. Real-world use is fine because the Rust manager writes UTF-8 bytes straight to the child's stdin via `tokio::process::ChildStdin` — no PowerShell in the loop.

### `cargo check` "finished in 0.5s" was a lie

After adding `mod sidecar;` to lib.rs and writing the manager, the first `cargo check` reported "finished in 0.5s" — much faster than the 2 minutes the new module should have taken. The culprit: an `Edit` operation on lib.rs failed silently because the file hadn't been Read in this session, so `mod sidecar;` was never added. cargo only re-checked the existing tree, found no changes, exited fast. Caught when I noticed the warning count didn't change. Fix: re-Read, then re-Edit, then re-check (which then took 38s and had the right warnings).

### `kill_on_drop(true)` matters

First version of `start_child` returned `(stdin, stdout)` without holding the `Child` handle. The Child dropped immediately after `start_child` returned, and tokio's default behavior is to *not* kill the child on drop, so the Python process stayed orphaned. Fixed by wrapping all three handles into a `ChildHandles` struct that lives for the duration of the supervisor task, with `Command::kill_on_drop(true)` on the spawn so the process actually terminates when the manager shuts down (e.g., during a restart).

### Restart-on-crash without clobbering in-flight replies

The supervisor distinguishes "child broken" errors (Crashed, Timeout, Io) from "child returned a structured error" (Validation). A broken child triggers `ChildExit::Crashed` → backoff → respawn; a structured error returns to the caller via the `oneshot` channel and the manager keeps going. The pending reply for the failed message is sent first, *then* the restart kicks in; that way the caller sees a useful error rather than a generic `Down`.

### `keychain_ref` field hung around in `types.ts`

The TypeScript `ConnectionProfile` type still had `keychain_ref: string` left over from the original Phase 2 spec. The Rust struct's `keychain_ref` was renamed to `password` in commit `ef22b5a` (with `#[serde(skip_serializing)]` so it never reaches the frontend), but `types.ts` was never updated. Caught while working on the validate-flow UI; fixed by removing `keychain_ref` from the TS type entirely. No runtime impact (no frontend code referenced the field), just a stale-spec smell.

### Stream-row decoding without the sqlx `time` feature

Phase 3 deliberately doesn't enable sqlx's `time`/`uuid`/`bigdecimal` features. Rationale: each one triggers a 2–5 minute incremental rebuild, and the Phase 3 done-when doesn't require pretty timestamps. Consequence: `TIMESTAMPTZ` and friends render as `<unsupported type: TIMESTAMPTZ>` in the UI. Phase 4 (provider abstraction) is a natural place to add the features when it's already touching `sqlx`.

## Verification performed

| Step | Result |
|---|---|
| Python sidecar import + handshake | ✓ prints `{"ready":true,"protocol":1,"sqlglot_version":"30.7.0"}` |
| Python validator unit tests (13 cases) | ✓ all pass, see PHASE_3_LOG "Done-when criteria" above |
| `cargo check` after sidecar manager | ✓ clean (2.04 s incremental, 2 dead-code warnings on `ping`) |
| `cargo check` after commands+futures dep | ✓ clean (2 m 35 s, dead-code warnings cleared) |
| `pnpm build` (TS + Vite) | ✓ clean (681 ms, 5.8 KB CSS / 203 KB JS) |
| `pnpm tauri dev` end-to-end | window opens, sidecar handshakes, generate→validate→run flow returns rows from local Postgres |

## Outstanding work, deferred

- **Comprehensive validator test suite.** The current 13 cases cover the major
  rejection categories per `docs/architecture/sql-validation.md`. The architecture
  doc lists more (recursive CTEs, lateral joins, dialect-specific obfuscations).
  Bring up to that spec when a regression makes it interesting.
- **`history` table writes.** Migration is in place from Phase 2; Phase 3
  doesn't write to it. Hook in when there's a UI surface to consume the
  history (probably Phase 7).
- **`EXPLAIN` pre-flight.** Listed in `docs/architecture/query-execution.md`
  as a Phase 3 enhancement; deferred per ADR 0009.
- **Unqualified column resolution in the validator.** Today only
  `table.column` / `alias.column` references are checked against the schema.
  A proper scope tracker (joins, subqueries, lateral) lands in Phase 7 when
  the redaction layer needs it.
- **Pretty timestamp rendering.** `sqlx`'s `time` feature and the matching
  decoder branches; deferred to Phase 4 to avoid a phase-3 cargo recompile.
- **Bundled Python.** Per ADR 0009, Phase 3 uses system Python. Phase 8
  (signed installers) bundles `python-build-standalone` + sqlglot.
- **Cross-OS verification.** Phase 3 only tested on Windows. macOS/Linux
  paths not exercised. The Python+venv bootstrap in `dev.ps1` is
  Windows-only; an equivalent Bash script lands when those machines exist.

## Operational notes for whoever continues

1. **Source `dev.ps1` in every fresh shell** — same as Phase 2, plus it now
   bootstraps the Python sidecar venv at `sidecar/.venv` and prepends its
   `Scripts/` to PATH. First dot-source after a fresh checkout takes a
   couple of minutes (creates venv + `pip install sqlglot`); subsequent
   shells are instant.
2. **Test the validator without Tauri.** Set `PYTHONPATH` to the project's
   `sidecar/` dir, then in Python: `import main; main._handle({"kind":"ping","id":"x"})`.
   Avoids fighting with PowerShell pipes when smoke-testing changes.
3. **Sidecar stderr is inherited.** Any Python exceptions print to the same
   console as `pnpm tauri dev`. Useful for debugging; rotate or redirect for
   release builds.
4. **The `<unsupported type: …>` placeholder is real, not a bug.** When you
   see it in a results column, the underlying Postgres type just needs a
   `try_get` branch added to `decode_value` in `src-tauri/src/commands.rs`,
   and possibly the matching sqlx feature in `Cargo.toml`.
5. **Killing the dev server kills the Python sidecar.** `kill_on_drop(true)`
   in `src-tauri/src/sidecar/mod.rs` ensures no orphan Python processes.
   Confirmed by `Get-Process python` after a `pnpm tauri dev` exit.
