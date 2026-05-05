# ADR 0012: Dialect rollout strategy for Phase 6

## Status

Accepted. SQLite and SQL Server are named deferrals with explicit revisit
conditions; this ADR is reopened when either of those lands.

## Context

`docs/ROADMAP.md` Phase 6 calls for adding MySQL, SQL Server, and SQLite
extractors so the Phase 3 done-when loop works for all four dialects.
`docs/architecture/schema-extraction.md` already lists the wire choice for
each (`sqlx` postgres / mysql / sqlite, plus `tiberius` for SQL Server).

Implementation reality differs from the architecture doc on two of the
four:

1. **SQLite via `sqlx-sqlite` collides with our existing `rusqlite +
   bundled-sqlcipher-vendored-openssl` for the local store.** Both crates
   link a C SQLite, with overlapping `sqlite3_*` symbols. Cargo may resolve
   it by feature unification, or it may not — this is not a five-minute
   investigation. ADR 0007 explicitly flagged this as a Phase 6 follow-up.
2. **SQL Server via `tiberius` is the project's largest single dep
   addition since Phase 1.** Its own TLS stack (separate from `rustls`),
   a Kerberos / NTLM auth dance for production setups, and a long build.
   We have no SQL Server to test against on the dev machine.

Both are real engineering work, not blockers fixable in the current commit
chunk.

## Decisions

### 1. Phase 6 ships MySQL only

MySQL is the cleanest add: `sqlx` already in the tree, one feature flag
(`mysql`), one new extractor module mirroring the Postgres one, the
extraction query is in `schema-extraction.md`. Net binary cost minimal.

### 2. The extractor module is generalized to dispatch by `Dialect`

`src-tauri/src/extract/mod.rs` becomes a thin dispatcher with two arms
(`Dialect::Postgres`, `Dialect::Mysql`). Adding a new dialect later means:

- a new `Dialect` enum variant in `schema.rs`,
- a new file under `src-tauri/src/extract/<dialect>.rs` with a
  `test_connection` and `extract_schema` function,
- one match arm in the dispatcher,
- one entry in the validation `CHECK` constraint on
  `connection_profiles.dialect`,
- one new option in the UI's dialect dropdown.

Recipe is documented in `PHASE_6_LOG.md`.

### 3. The connection-profile UI exposes a dialect dropdown

Postgres and MySQL are selectable; SQLite and SQL Server show as disabled
options labeled "(deferred — see PHASE_6_LOG.md)" so users discover the
limit and where to read about it.

### 4. SQLite and SQL Server are named deferrals

#### SQLite

Defer until either:
- A maintained SQLite extension that bridges `sqlx-sqlite` and SQLCipher
  ships, **or**
- We commit to migrating the local store off SQLCipher (which would mean
  reopening ADR 0007 anyway), **or**
- The `sqlite3_*` symbol-collision investigation is given a dedicated
  half-day with the right tooling (`cargo tree -d`, careful feature unification,
  possibly `--no-default-features` on rusqlite + a separate `bundled` build
  for SQLCipher only).

The current believable cost is several hours of linker debugging. Not on
Phase 6's critical path.

Until then: SQLite users extract schema from a `.sqlite` file via the
upcoming file-based ingestion (deliberately out of scope for v1 per
`docs/PROJECT_BRIEF.md`'s non-goals — we route them to a workaround).

#### SQL Server

Defer until either:
- A `tiberius` setup is paid down on a dev machine that has a SQL Server
  instance to test against, **or**
- A specific user reports they need it.

The cost story:
- ~5–10 MB binary growth from `tiberius` + its deps.
- Significant compile-time hit (5+ minutes incremental on first build).
- New TLS stack to vet (`tiberius` does not use `rustls`).
- No way to validate end-to-end without a SQL Server we haven't set up.

## Tradeoffs accepted

- **Phase 6 partially satisfies its done-when.** "All four dialects pass
  the Phase 3 loop" is amended to "Postgres + MySQL pass; SQLite + SQL
  Server are named deferrals with revisit conditions." Recorded in
  ROADMAP and PHASE_6_LOG with the same level of honesty as the Phase 5
  benchmark deferral.
- **Postgres extraction logic is restructured.** The pre-Phase-6 code had
  a single `extract::postgres::extract_schema`; Phase 6 splits this into
  a dispatcher + per-dialect modules. Mechanical refactor; no behavior
  change for Postgres.
- **The UI advertises a non-functional dialect.** The dropdown shows
  SQLite and SQL Server with a visible "deferred" tag and a tooltip
  pointing at PHASE_6_LOG. Better than hiding them and surprising the
  user with "why is my dialect not in the list."

## Alternatives considered

- **Ship all four dialects in one Phase 6 chunk.** Rejected — the SQLite
  symbol collision and the SQL Server tiberius onboarding each genuinely
  consume a half-day to a day of careful work. Bundling them with MySQL
  inflates risk and review surface for no payoff.
- **Defer Phase 6 entirely until all four are ready.** Rejected — MySQL
  is cleanly addable today, and shipping it incrementally tightens the
  feedback loop without committing us to SQLite/SQL Server's quirks now.
- **Drop SQLCipher to unblock `sqlx-sqlite` for both store and user
  ingestion.** Rejected — that's a Phase 7 keychain-revisit conversation
  (ADR 0008). Folding it into Phase 6 conflates two security decisions.

## Code locations pinned to this ADR

- `src-tauri/Cargo.toml` — add `mysql` to `sqlx` features.
- `src-tauri/src/schema.rs` — `Dialect` enum gains `MySql`.
- `src-tauri/src/extract/mod.rs` — dialect dispatcher.
- `src-tauri/src/extract/postgres.rs` — unchanged behaviorally;
  potentially renamed entry points.
- `src-tauri/src/extract/mysql.rs` — new MySQL extractor.
- (no schema migration needed — `connection_profiles.dialect` is plain
  `TEXT NOT NULL` with no CHECK constraint; widening the set of valid
  values is a code-only change.)
- `src/App.tsx` + `src/types.ts` — dialect dropdown plus
  `(deferred)`-tagged options for SQLite / SQL Server.
- `docs/PHASE_6_LOG.md` — the recipe for adding a future dialect.
