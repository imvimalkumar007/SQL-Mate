# ADR 0004: sqlglot via Python sidecar for SQL validation

## Status

Accepted.

## Context

SQL validation is a load-bearing security control. We need to:
- Parse SQL across multiple dialects (Postgres, MySQL, SQL Server, SQLite, Snowflake, BigQuery)
- Walk the AST to confirm only `SELECT`-shaped operations are present
- Resolve table and column references against the user's schema model

The Rust ecosystem option is `sqlparser-rs`. The Python ecosystem option is `sqlglot`.

## Decision

We use `sqlglot`, hosted in a Python sidecar process that the Rust core communicates with over stdin/stdout JSON.

## Rationale

- **Dialect coverage.** `sqlglot` supports more dialects more accurately than `sqlparser-rs` as of late 2025. It is actively used by major data tooling (e.g., dbt) and gets dialect updates quickly.
- **AST manipulation primitives.** `sqlglot` has higher-level helpers for walking and rewriting ASTs, which we need for read-only enforcement and schema-grounded reference checking. Replicating these in Rust would be substantial work.
- **Sidecar isolation is itself a security property.** The validator runs in a separate process from the database driver and the LLM client. A bug in `sqlglot` cannot read the database connection or the API key directly. This is a useful boundary.
- **Process startup cost is amortized.** The sidecar starts once at app launch and stays alive. Per-request overhead is just a JSON round-trip over a pipe — fast enough that users don't perceive it.

## Tradeoffs accepted

- **Bundling Python.** We must ship a Python interpreter with the app. We use a stripped-down embedded Python (via `python-build-standalone`) and bundle only `sqlglot` and its dependencies. Adds roughly 20–30 MB to the installer. Acceptable.
- **Two languages in the codebase.** The sidecar code is ~200 lines of Python. Small, well-contained, with its own test suite. The boundary between Rust and Python is a single JSON protocol, kept narrow.
- **One more thing to keep updated.** `sqlglot` releases frequently. We pin the version and update deliberately, with the validator test suite as the regression gate.

## Alternatives considered

- **`sqlparser-rs` only.** Rejected for dialect coverage and AST manipulation gaps. May reconsider if the Rust ecosystem catches up; the validator interface is designed to allow swapping the implementation.
- **Run `sqlglot` via PyO3 in-process.** Rejected because in-process Python embedding has a poor security story (segfaults, GIL interactions, hard-to-debug crashes affect the whole app) and a worse build/distribution story (PyO3 + Rust + Python + cross-compilation is painful).
- **Validate by running `EXPLAIN` on the user's database.** Considered as a complementary check but not as the primary control. `EXPLAIN` would catch unknown tables/columns, but it does not by itself enforce read-only (the database does that via permissions, not via parsing). We do plan to use `EXPLAIN` as a Phase 3 enhancement on top of `sqlglot` validation.
- **Write a custom dialect-aware parser.** Rejected. Writing a multi-dialect SQL parser is a multi-year project. We have better uses for that time.
