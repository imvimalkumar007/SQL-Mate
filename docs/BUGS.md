# Bugs and known issues

A living list of bugs, limitations, and deferred items found during end-to-end
testing. Each entry has a status, a brief description, where it lives in the
code, and what closing it requires. Prefer adding to this file over scattering
TODOs through the source.

Status legend:
- **bug** — the implementation does not match the intended behavior; should be fixed.
- **limitation** — a known scope cut from a prior phase; revisit when the surrounding work needs it.
- **deferred** — explicitly punted to a later phase or external condition. See the linked ADR or phase log.
- **manual** — needs human verification in the GUI; not a bug yet.

End-to-end test pass: 2026-05-04. Tauri dev binary (PID 384) launched against
local Postgres 17.9 at `localhost:54320` with the 4-table customers / products
/ orders / order_items seed schema. Sidecar handshake + 8 validator scenarios
verified directly against `sidecar/main.py` (rejects DROP, CTE-with-mutation,
multi-statement, denylisted functions, system tables, unknown tables; accepts
SELECT in both `postgres` and `mysql` dialects).

---

## Resolution log

Most-recent first. Each entry covers one round of fixes against the bugs in
this file. Mention the bug numbers below that the entry resolves and link to
the commit hashes once landed.

### 2026-05-05 — Phase 6.5 fix pass (before Phase 7)

Closes bugs #1, #2, #3, and the addressable portion of #4.

- **Bug #1 (validator dialect):** `validate_sql` and `execute_query` now
  fetch the connection profile and pass `profile.dialect` to
  `sidecar.validate(...)` instead of the hardcoded `"postgres"` string.
  layer-1 prevalidation runs before the profile lookup so dialect-agnostic
  rejections still short-circuit early.
- **Bug #2 (execute_query MySQL):** `execute_query` now dispatches on
  `profile.dialect` to a per-dialect helper:
  - `execute_postgres` keeps the original `PgConnectOptions` +
    `SET default_transaction_read_only` + `SET statement_timeout` shape.
  - `execute_mysql` uses `MySqlConnectOptions`, sets
    `SET SESSION TRANSACTION READ ONLY`, and best-effort sets
    `MAX_EXECUTION_TIME` (MySQL 5.7.4+ only — failure ignored so MariaDB
    still runs read-only without timeout enforcement, with the read-only
    role remaining the primary control).
  - Each helper has its own `decode_*_value(row, i)` function so the
    sqlx generic decode chain stays statically typed against the right `Row`.
- **Bug #3 (history dead path):** new `store::history` module with
  `record_history`, `update_history_validation`, `update_history_execution`,
  `list_history`, `clear_history`. `generate_sql` now writes a row at
  generation time and returns `{sql, history_id}`. `validate_sql` and
  `execute_query` accept an optional `history_id` and update the row's
  validation status / execution metrics if provided. New Tauri commands
  `list_history` and `clear_history` expose the table for the future
  in-app history view (Phase 7+). Frontend threads `history_id` through
  generate → validate → run.
- **Bug #4 (extended decoders):** `sqlx-postgres` and `sqlx-mysql` are now
  declared as direct dependencies (alongside the `sqlx` umbrella) with
  `time` + `uuid` features enabled. Going through the umbrella crate's
  type features pulled `sqlx-sqlite` into the dep graph because sqlx 0.8.6
  doesn't gate `sqlx-sqlite?/time` behind the `?` optional-dep gate;
  `sqlx-sqlite` then collided with `rusqlite + bundled-sqlcipher` over
  `libsqlite3-sys` (the same ADR 0012 §4 collision). The per-driver
  declaration sidesteps the cascade. `decode_pg_value` now handles
  `OffsetDateTime`, `PrimitiveDateTime`, `Date`, `Time`, and `Uuid`;
  `decode_mysql_value` handles the same date/time set plus signed/unsigned
  integers and a binary-bytes fallback. `json` was *not* enabled — see the
  Cargo.toml comment and the still-open portion of #4 below.

**Verification:**
- `cargo check` clean — 8.36 s incremental, 5 pre-existing dead-code warnings,
  zero new warnings from any of the changes.
- `pnpm build` (TS + Vite) clean — 709 ms, 5.80 KB CSS / 208.57 KB JS.
- Frontend types + call sites updated in `src/types.ts` and `src/App.tsx`.

**Carried forward** to a later round:
- JSON / JSONB columns still render via the String fallback (Postgres returns
  them as text at the wire level when the json feature is off, so they're
  legible — just not parsed into structured `serde_json::Value`). Unblocking
  this needs the libsqlite3-sys collision resolved per ADR 0012 §4 *or* a
  `[patch.crates-io]` workaround for `sqlx-sqlite`.
- Dead-code warnings (#12) untouched. Will revisit when Phase 7's redaction
  layer either uses `ProviderCapabilities` / sidecar `Ping` or proves them
  removable.

---

## Confirmed bugs

### 1. Validator dialect hardcoded as `"postgres"` for MySQL connections — **fixed 2026-05-05**

**Status:** ~~bug~~ **resolved** (see resolution log)
**Location:** [src-tauri/src/commands.rs:493](src-tauri/src/commands.rs#L493), [src-tauri/src/commands.rs:552](src-tauri/src/commands.rs#L552)

Both `validate_sql` and `execute_query` invoke
`sidecar.validate("postgres", ...)` regardless of the active connection's
dialect. `sqlglot` will still parse most SELECTs under the wrong dialect, but
MySQL-specific syntax (e.g. backtick identifiers, `LIMIT n, m`) will be
rejected as a parse error.

**Fix:** read `profile.dialect` and pass it through. The store already
records dialect per profile and `extract::dispatch_extract_schema` already
uses it. Five-line change. Already noted as a Phase 6 follow-up in
[PHASE_6_LOG.md](PHASE_6_LOG.md) §"Operational notes".

### 2. `execute_query` is Postgres-only — **fixed 2026-05-05**, then **moot 2026-05-06** (Phase 9 UX overhaul)

**Status:** ~~bug~~ **resolved**, then made **moot** by execution removal in the Phase 9 UX overhaul. The `execute_query` Tauri command no longer exists — the app does not run generated SQL at all per SECURITY_MODEL.md T2.
**Location:** [src-tauri/src/commands.rs:561-603](src-tauri/src/commands.rs#L561-L603)

`execute_query` always builds a `PgConnectOptions`, runs the
Postgres-specific `SET default_transaction_read_only` and
`SET statement_timeout = N`, and decodes via `PgRow`. A MySQL profile selected
in the dialect dropdown will pass the extractor (Phase 6) and the validator
(once bug #1 is fixed) but fail at the run-query step because `sqlx-mysql`
rows don't decode through the `decode_value(PgRow)` helper.

**Fix:** dispatch `execute_query` on `profile.dialect` the same way
`extract::dispatch_*` does. MySQL needs `MySqlConnectOptions`,
`SET SESSION TRANSACTION READ ONLY` (matches `extract/mysql.rs`), and a parallel
`decode_mysql_value(MySqlRow)`. This was missed when Phase 6 stopped at the
extractor side; the MySQL win is incomplete until run-query also dispatches.

### 3. `history` table is created but never written to — **fixed 2026-05-05**

**Status:** ~~bug (dead code path)~~ **resolved** (see resolution log)
**Location:** [src-tauri/migrations/0001_initial_schema.sql:46](src-tauri/migrations/0001_initial_schema.sql#L46) — table; no Rust code matches `history`.

Migration 0001 creates a `history` table for past questions / generated SQL /
results, but no code path in `src-tauri/src/` writes to or reads from it.
Either remove the table from the migration (forward-only — would need a new
migration to drop) or wire `generate_sql` / `execute_query` to log into it
behind the telemetry-opt-in pattern.

**Fix preference:** wire it up in Phase 7 or 8 as part of the in-app history
view. Removing the table is the wrong call — it's cheap to keep an empty table
and the migration is forward-only.

### 4. Generated SQL renders Postgres timestamp / UUID / JSON columns as `<unsupported type: ...>` — **moot 2026-05-06** (Phase 9 UX overhaul)

**Status:** ~~limitation~~ **moot**. The decoders existed only on the
`execute_query` path. With execution removed, there are no rows to
render and no decoder to extend. If a future version reintroduces
execution, the libsqlite3-sys-collision constraint on the sqlx `json`
feature still applies and would need to be solved then.

---

## Known limitations

### 5. OS keychain integration deferred

**Status:** deferred to Phase 7
**Reference:** [docs/decisions/0008-no-keychain-in-phase-2.md](decisions/0008-no-keychain-in-phase-2.md)

API keys and DB passwords currently live in the SQLCipher-encrypted local
store with the SQLCipher key in a sibling file under the app data dir. The
intended target is OS keychain (macOS Keychain / Windows Credential Manager /
Linux Secret Service) per `docs/SECURITY_MODEL.md`. The `keyring` 3.x crate
silently failed to persist on Windows 10.0.26200 during Phase 2; `keyring` 4.0
restructured its public error type. Revisit alongside Phase 7's redaction
work.

### 6. SQLite as a user dialect deferred

**Status:** deferred
**Reference:** [docs/decisions/0012-dialect-rollout-strategy.md](decisions/0012-dialect-rollout-strategy.md) §4

`sqlx-sqlite` and the existing `rusqlite + bundled-sqlcipher-vendored-openssl`
both pull `libsqlite3-sys`. The SQLCipher-modified build may export different
symbols than vanilla SQLite; reproducing and resolving feature unification is
a focused half-day. Surfaced in the dialect dropdown as a disabled option.
Revisit when a user requests SQLite specifically.

### 7. SQL Server as a user dialect deferred

**Status:** deferred
**Reference:** [docs/decisions/0012-dialect-rollout-strategy.md](decisions/0012-dialect-rollout-strategy.md) §5

`tiberius` (SQL Server's most-maintained Rust driver) brings a separate TLS
stack from `rustls`, separate auth (Kerberos/NTLM in production), and a
heavier compile / binary footprint. Surfaced as a disabled dropdown option.
Revisit when a real SQL Server is available for testing or a user asks.

### 8. 200-table quality benchmark deferred

**Status:** deferred to Phase 9
**Reference:** [docs/decisions/0011-embedding-based-schema-retrieval.md](decisions/0011-embedding-based-schema-retrieval.md), [PHASE_5_LOG.md](PHASE_5_LOG.md)

Phase 5 ships the embedding retrieval path end-to-end (provider-endpoint
embeddings, JSON-stored vectors, brute-force cosine, top-20 + FK neighborhood
expansion). The actual quality measurement on a 200-table schema with a
labeled question set is genuinely deferred to first-five-users (Phase 9)
because we don't have either the schema or the ground-truth labels yet.

### 9. Local embedding model deferred

**Status:** deferred
**Reference:** [docs/decisions/0011-embedding-based-schema-retrieval.md](decisions/0011-embedding-based-schema-retrieval.md)

Phase 5 only supports provider-endpoint embeddings (OpenAI /
OpenAI-compatible). A bundled local embedding model (e.g. via `fastembed-rs`)
is a follow-up — would let users get retrieval without exposing schema names
to any embedding provider, satisfying the "no schema content over network"
posture more strictly than the current "BYO embedding key" pattern.

### 10. macOS and Linux end-to-end verification not performed

**Status:** deferred
**Reference:** [PHASE_1_LOG.md](PHASE_1_LOG.md), [ROADMAP.md](ROADMAP.md) Phase 1

The Phase 1 done-when called for end-to-end verification on all three target
OSes. Only Windows has been exercised. macOS and Linux have not been
attempted because no machines are available to the developer. Cross-OS
verification is a hard prerequisite for Phase 8 (signed installers) and
should not slip further.

### 11. Tauri window may open minimized or offscreen on first launch

**Status:** intermittent, environmental
**Location:** [src-tauri/src/main.rs](src-tauri/src/main.rs) — `setup` callback

On Windows, the app window has occasionally opened either minimized or with
its top-left coordinate at `(-32000, -32000)` (the offscreen sentinel),
requiring a manual `ShowWindow(SW_RESTORE) + SetForegroundWindow` from
PowerShell to surface it. Reproducible only after suspended sessions or
multi-monitor disconnects; not reliably reproducible on a fresh boot.

**Fix:** add the Win32 `ShowWindow + SetWindowPos + SetForegroundWindow` recipe
to the Tauri `setup` callback so the window always positions itself
on-screen. Bundle with Phase 8.

### 12. Five Rust dead-code warnings

**Status:** cleanup
**Location:** various

`cargo check` reports unused fields / methods on `StoredEmbedding.dimensions`,
`ProviderCapabilities`, the sidecar `Ping` types, etc. None of these are
incorrect — they exist as deliberately-public surface for future code paths
or as forward-compatible IPC shapes — but they should either be exercised by
tests or annotated with `#[allow(dead_code)]` plus a comment pointing at the
phase that consumes them.

---

## Manual verification checklist (GUI)

Items that require a human in the loop because the dev shell can't drive the
window. Run before tagging Phase 6 fully complete or any later phase:

- [ ] **Provider config:** add an Anthropic key in the provider card, click
      "Save", reload the app, confirm the key persists across restart and
      that the active provider indicator matches.
- [ ] **Provider switch:** add a second provider (OpenAI), switch active,
      generate SQL, confirm the request goes to the new provider's URL (open
      DevTools → Network and look for `api.openai.com` vs. `api.anthropic.com`).
- [ ] **Connection test:** enter the local Postgres credentials, click
      "Test connection", confirm a green status without saving.
- [ ] **Connection save:** save the profile, reload the app, confirm the
      profile reappears in the connections list.
- [ ] **Schema extract:** click "Extract schema", confirm the 4-table seed
      appears in the schema card with FKs visible.
- [ ] **Generate flow:** ask "list the top 3 customers by total order
      value", confirm a SQL query renders, confirm "validate" lights green,
      click "run", confirm a results table.
- [ ] **Validator rejection UI:** paste `DROP TABLE customers` into the
      generated-SQL textarea, click "validate", confirm the error UI surfaces
      a clear "query contains a forbidden mutating keyword" message.
- [ ] **Embedding stats card:** if the schema is small (< 50 tables),
      confirm the embedding stats card shows 0 / "not used"; if large,
      confirm it shows the top-N retrieval window.
- [ ] **MySQL extract:** add a MySQL profile (no live MySQL needed —
      "Test connection" failure is fine), confirm the dropdown selection
      persists and the extract attempt produces a clear error rather than
      silently routing to Postgres.
- [ ] **Disabled dialects:** confirm SQLite and SQL Server appear as
      disabled options in the dialect dropdown with a "(deferred)" suffix.
- [ ] **Window restore:** minimize the window, then re-activate from the
      taskbar, confirm it restores cleanly.

---

## Operational gaps

Not bugs in the binary, but loose ends in the project's operational posture:

- **Branch protection on `main` not enforced on GitHub.** The repo currently
  allows direct pushes to main, which is consistent with how Phase 1–6
  documentation has been committed but should tighten before Phase 9.
- **No `gitleaks` or equivalent scan in CI.** The non-negotiable on
  "no plaintext secrets" should be enforced mechanically, not on author
  vigilance alone.
- **No CI at all.** `cargo check`, `cargo test`, `pnpm build`, and the
  sidecar Python tests run only on the developer's machine. Phase 8 will need
  GitHub Actions for cross-OS builds anyway; ride that work to add a
  pre-merge check pipeline.
