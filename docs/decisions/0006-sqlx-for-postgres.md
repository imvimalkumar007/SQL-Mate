# ADR 0006: sqlx for the Postgres driver

## Status

Accepted.

## Context

Phase 2 introduces a database connection from the Rust core to the user's Postgres server. The architecture (`docs/architecture/schema-extraction.md`) already names `sqlx` for Postgres, MySQL, and SQLite (with `tiberius` for SQL Server). This ADR records the version and feature pin and the TLS configuration choice, by analogy with ADR 0005 for the HTTP client.

## Decision

We use `sqlx`, pinned to an exact version, with default features disabled and a minimal feature set:

```toml
sqlx = { version = "=0.8.6", default-features = false, features = ["runtime-tokio-rustls", "postgres"] }
```

The pin and the feature set are part of this decision. Bumping or changing features requires updating this ADR.

## Rationale

- **Async-native fits Tauri's tokio runtime.** Same reasoning as ADR 0005 for reqwest. A sync DB driver would block tokio worker threads in Tauri command handlers.
- **`runtime-tokio-rustls` matches ADR 0005.** All TLS in the project's network paths (the LLM HTTP path and the Postgres connection) uses `rustls`. We avoid `native-tls` to keep the cross-platform build story simple and to skip a system OpenSSL dependency in the network paths.
- **One driver crate covers Postgres now and MySQL/SQLite later.** Phase 6 will add MySQL and SQLite dialects; using `sqlx` from the start means each new dialect adds only a feature flag, not a new top-level crate. This is consistent with `docs/architecture/schema-extraction.md`.
- **Disabling default features is consistent with the project's stance.** `CLAUDE.md` directs us to minimize dependency surface in security-sensitive paths; the DB connection path is one of them.
- **No `chrono`/`time`/`uuid` features yet.** The Phase 2 extraction query returns only text and integer types, no timestamps. We can add those features later if a query in a future phase needs them.

## Tradeoffs accepted

- **Larger dependency tree.** `sqlx` brings in a substantial set of crates (the SQL parser, async pool, connection management). We accept this for the API ergonomics and the multi-dialect path.
- **No compile-time query checking in Phase 2.** sqlx's `query!()` macro requires a live database at compile time. We use `query()` (the runtime-checked version) instead so the build does not depend on a database. Worth re-evaluating in Phase 6 when more dialects land — at that point a CI-only compile-time check could catch typos.
- **Strict version pin requires manual updates.** Same tradeoff as ADR 0005.

## Alternatives considered

- **`tokio-postgres`.** Lower-level, smaller dep tree. Rejected because Phase 6 would then require a separate driver crate per dialect, increasing surface area and inconsistency. `sqlx`'s feature-flag model is a better fit for the multi-dialect roadmap.
- **`diesel`.** Synchronous by default; `diesel-async` exists but is less mature. Rejected for the same reason as `ureq` in ADR 0005 — the async-Tauri fit is the dominant constraint.
- **A hand-rolled Postgres protocol implementation.** Rejected as obviously out of scope.
