# Architecture

This document describes the high-level system design. Each module has its own deeper doc under `docs/architecture/`.

## Shape of the system

SQL Mate is a single-binary desktop application. There is no server. There is no cloud component. The only network calls the application makes are:

1. Direct HTTPS to the LLM provider the user configured, using the user's own API key.
2. Direct database connections from the user's machine to their own database, over the network the user already trusts for that purpose.
3. A startup check against a static model registry JSON file (cacheable, fail-open if offline).

Nothing else.

```
┌─────────────────────────── User's machine ───────────────────────────┐
│                                                                       │
│  ┌──────────────────────────────────────────────────────────────┐    │
│  │  SQL Mate desktop app (Tauri)                                │    │
│  │                                                              │    │
│  │  ┌────────────────┐    ┌─────────────────┐    ┌──────────┐  │    │
│  │  │ React frontend │ ←→ │ Rust core       │ ←→ │ SQLite   │  │    │
│  │  └────────────────┘    │  - extractor    │    │  cache   │  │    │
│  │                        │  - validator*   │    └──────────┘  │    │
│  │                        │  - executor     │                  │    │
│  │                        │  - llm client   │    ┌──────────┐  │    │
│  │                        └─────────────────┘ ←→ │ OS       │  │    │
│  │                                  ↕             │ keychain │  │    │
│  │                        ┌─────────────────┐    └──────────┘  │    │
│  │                        │ Python sidecar  │                  │    │
│  │                        │  (sqlglot AST)  │                  │    │
│  │                        └─────────────────┘                  │    │
│  └──────────────────────────────────────────────────────────────┘    │
│                                ↕                                      │
│                   ┌────────────────────────┐                          │
│                   │ User's database        │                          │
│                   │ (read-only role)       │                          │
│                   └────────────────────────┘                          │
└──────────────────────────────────────────────────────────────────────┘
                                 ↕
                   ┌────────────────────────┐
                   │ LLM provider chosen by │
                   │ user (Anthropic, etc.) │
                   │ Schema + question only │
                   └────────────────────────┘
```

\* The Rust core does first-pass dialect-aware syntactic checks; the Python sidecar runs `sqlglot` for AST-level read-only enforcement. See `docs/decisions/0004-sqlglot-for-validation.md`.

## Modules

The system has six modules, each documented separately:

- **Schema extraction** (`docs/architecture/schema-extraction.md`) — connects to the user's database with read-only credentials, runs metadata-only queries against `information_schema` or equivalent, normalizes the result into the canonical schema model.
- **Schema store** (`docs/architecture/schema-store.md`) — local SQLite database holding the canonical schema model, user annotations, redaction rules, and query history. Encrypted at rest using a key derived from the OS keychain.
- **LLM provider** (`docs/architecture/llm-provider.md`) — abstraction over Anthropic, OpenAI, and OpenAI-compatible endpoints. Handles prompt caching where supported, structured outputs where supported, graceful fallback otherwise.
- **SQL generation** (`docs/architecture/sql-generation.md`) — assembles the prompt from the relevant schema slice plus the user's question, calls the provider, parses the response.
- **SQL validation** (`docs/architecture/sql-validation.md`) — parses the generated SQL with `sqlglot`, enforces read-only, checks that all referenced tables and columns exist in the schema, returns the validated query or a structured error.
- **Query execution** (`docs/architecture/query-execution.md`) — runs the validated SQL against the user's database in a read-only transaction with a row-count cap and a timeout, returns results to the frontend without ever sending them off-device.

UI flows that span these modules are documented in `docs/architecture/ui-flows.md`.

## Canonical schema model

Every ingestion path normalizes to the same intermediate representation:

```rust
struct SchemaModel {
    dialect: Dialect,
    schemas: Vec<DbSchema>,
    extracted_at: Timestamp,
    source: ExtractionSource,
}

struct DbSchema {
    name: String,
    tables: Vec<Table>,
}

struct Table {
    name: String,
    columns: Vec<Column>,
    primary_key: Vec<String>,
    foreign_keys: Vec<ForeignKey>,
    user_annotation: Option<String>,
    excluded: bool,
}

struct Column {
    name: String,
    data_type: String,
    nullable: bool,
    default: Option<String>,
    user_annotation: Option<String>,
    sensitive: bool,
}

struct ForeignKey {
    columns: Vec<String>,
    references_schema: String,
    references_table: String,
    references_columns: Vec<String>,
}
```

Both the live extractor and any future file-based ingestion produce this shape. Every downstream module (LLM provider, validator, UI) reads from this shape and never from raw extraction output.

## Data flow for a single question

1. User types a question.
2. Frontend sends question to Rust core.
3. Core retrieves the relevant schema slice from the schema store. For schemas with under ~50 tables this is "all of it." For larger schemas, an embedding-based retriever picks the top N tables by similarity, then expands to include their foreign-key neighbors.
4. Core composes a prompt: system message + schema slice (respecting redaction rules) + question.
5. Core reads the API key from the OS keychain.
6. Core sends the request to the configured provider.
7. Response is parsed for the SQL query and explanation.
8. SQL is sent to the Python sidecar for validation.
9. If validation fails, the user sees a structured error explaining what failed.
10. If validation passes, the SQL is shown in the UI for review, with the explanation.
11. User clicks "run." Core executes the SQL in a read-only transaction with timeout and row cap.
12. Results are returned to the frontend and displayed. They are stored in the local query history, not sent anywhere.

## Threading model

- The frontend is a single-page React app.
- The Rust core uses `tokio` for async IO. Database calls, LLM calls, and sidecar IPC are all async.
- The Python sidecar is a long-lived child process that communicates over stdin/stdout using newline-delimited JSON. It is started on app launch and reused.

## Persistence

- Schema cache, annotations, query history: SQLite at `<app data dir>/sql-mate/store.db`. Encrypted using SQLCipher with a key derived from a value stored in the OS keychain.
- Connection profiles: same SQLite file. Connection strings are not stored — only the host/port/database/username and a reference to the keychain entry that holds the password.
- API keys: OS keychain only. Never written to disk by us.
- Logs: `<app data dir>/sql-mate/logs/`. Structure-only (counts, timings, error types). Never schema content. Never query content. Rotated daily, capped at 30 days.

## What we do not have and will not add without an ADR

- Any outbound network call beyond the three listed at the top.
- Any local server listening on a port.
- Any background sync, auto-update of schema, or telemetry beep.
- Any code that reads row data into the LLM call path.
