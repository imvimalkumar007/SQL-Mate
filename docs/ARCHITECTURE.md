# Architecture

This document describes the high-level system design. Each module has its own deeper doc under `docs/architecture/`.

## Shape of the system

SQL Mate is a single-binary desktop application. There is no server. There is no cloud component. The only network calls the application makes are:

1. Direct HTTPS to the LLM provider the user configured, using the user's own API key.
2. A direct database connection from the user's machine to their own database, **only for schema extraction** (a single metadata query against `information_schema`). The app does not execute generated SQL — see Phase 9 below.

Nothing else. The model registry is bundled with the app, not fetched.

```
┌──────────────────────────────── User's machine ─────────────────────────────────┐
│                                                                                  │
│  ┌────────────────────────────────────────────────────────────────────────┐    │
│  │  SQL Mate desktop app (Tauri)                                          │    │
│  │                                                                        │    │
│  │  ┌────────────────┐  ┌────────────────┐  ┌─────────────────┐  ┌─────┐ │    │
│  │  │ Main window    │  │ Widget window  │  │ Rust core       │ │SQL  │ │    │
│  │  │ (admin)        │  │ (Win-only      │← │ - extractor     │← │Cipher│ │    │
│  │  │ schema review, │  │  hotkey-       │ ←┤ - validator*    │ ←┤store│ │    │
│  │  │ redaction,     │← │  summoned;     │  │ - llm client    │  └─────┘ │    │
│  │  │ history,       │  │  ADR 0014)     │  │ - redact +      │          │    │
│  │  │ settings       │  │  pill ↔ widget │  │   request log   │  ┌─────┐ │    │
│  │  └────────────────┘  └────────────────┘  └─────────────────┘  │tray │ │    │
│  │       ↕                    ↕                       ↕          │icon │ │    │
│  │       └────────────────────┴───────────────────────┘          └─────┘ │    │
│  │                                  ↕                                     │    │
│  │                        ┌─────────────────┐                             │    │
│  │                        │ Python sidecar  │                             │    │
│  │                        │  (sqlglot AST)  │                             │    │
│  │                        └─────────────────┘                             │    │
│  │                                                                        │    │
│  │  Global hotkey (Ctrl+Shift+Space, rebindable) → toggle widget          │    │
│  └────────────────────────────────────────────────────────────────────────┘    │
│                                ↕                                                 │
│                   ┌────────────────────────┐                                    │
│                   │ User's database        │                                    │
│                   │ — schema extraction    │                                    │
│                   │   only (metadata)      │                                    │
│                   └────────────────────────┘                                    │
└─────────────────────────────────────────────────────────────────────────────────┘
                                 ↕
                   ┌────────────────────────┐
                   │ LLM provider chosen by │
                   │ user (Anthropic, etc.) │
                   │ Schema + question only │
                   └────────────────────────┘
```

\* The Rust core does first-pass dialect-aware syntactic checks; the Python sidecar runs `sqlglot` for AST-level read-only enforcement. See `docs/decisions/0004-sqlglot-for-validation.md`. The validator's verdict gates whether the SQL is shown to the user; the app does not run it.

## Modules

The system has six live modules plus one removed-but-documented:

- **Schema extraction** (`docs/architecture/schema-extraction.md`) — connects to the user's database with read-only credentials, runs metadata-only queries against `information_schema` or equivalent, normalizes the result into the canonical schema model.
- **Schema store** (`docs/architecture/schema-store.md`) — local SQLCipher-encrypted SQLite database holding the canonical schema model, user annotations, redaction rules, provider configs, embeddings, history, and Phase 10's `widget_state` (last position, last question, last SQL, pill flag). On Windows, the SQLCipher key is stored in Windows Credential Manager (DPAPI-encrypted per user, ADR 0016); on macOS/Linux it is in a `chmod 0600` sibling file.
- **LLM provider** (`docs/architecture/llm-provider.md`) — closed-enum dispatch over Anthropic, OpenAI, and OpenAI-compatible endpoints. Handles prompt caching where supported, structured outputs where supported, graceful fallback otherwise.
- **SQL generation** (`docs/architecture/sql-generation.md`) — overlays persisted annotations + redactions onto the canonical schema model, narrows to the relevant slice (top-N by embedding similarity for large schemas, all tables otherwise), obfuscates sensitive column names, assembles the prompt, calls the provider, de-obfuscates the response.
- **SQL validation** (`docs/architecture/sql-validation.md`) — Layer 1 in Rust, Layer 2 via `sqlglot` in the Python sidecar. Returns the validated query or a structured error. The verdict gates whether the SQL is shown to the user.
- **Widget shell** (Phase 10 / ADR 0014; Phase 11 / ADR 0015; design at `docs/design/widget-design-spec.md`) — Windows-only floating widget summoned by a global hotkey (`Ctrl+Shift+Space` by default, rebindable in Settings) and backed by a system tray icon. Two windows in one Tauri app: `main` and `widget`, each with its own Vite entry point. The widget reuses the existing `generate_sql` / `validate_sql` commands; window resize between expanded (400×500) and pill (220×30) is driven from Rust (`apply_widget_size_from_store`) before each show so the WebView2 render and window dimensions never get out of sync. When multiple connection profiles exist, the header exposes a connection picker (ADR 0015): a fixed-position overlay listing all profiles with schema age, a per-profile re-extract affordance, and a stale-SQL dim when the user switches connections mid-session.
- **~~Query execution~~** (`docs/architecture/query-execution.md`) — **removed in Phase 9**. The doc is kept as an archaeology marker. The app generates and validates SQL but does not execute it; users copy the validated SQL and run it in their own tool.

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

1. User types a question into the "Ask a question" section.
2. Frontend invokes `generate_sql` on the Rust core.
3. Core loads the persisted schema model and overlays the user's annotations + redactions on top of it.
4. Core retrieves the relevant schema slice. For schemas with under ~50 tables this is "all of it." For larger schemas, an embedding-based retriever picks the top N tables by similarity, then expands to include their foreign-key neighbors.
5. Core obfuscates sensitive column names with stable placeholders (`r_c_1`, `r_c_2`, …) — the LLM never sees the real names.
6. Core composes the prompt: system message + (post-redaction, post-obfuscation) schema slice + question.
7. Core reads the API key from the SQLCipher store (keychain pending ADR 0008).
8. Core captures the exact bytes about to go out into the in-memory request log (last-request-per-connection, accessible from the UI for audit).
9. Core sends the request to the configured provider.
10. Response is parsed for the SQL query.
11. Core de-obfuscates the response (substitutes original column names back).
12. Core writes a row to the `history` table (question, generated SQL, validation status pending).
13. SQL is returned to the frontend with the originating model id. UI renders it with syntax highlighting + a copy button.
14. UI invokes `validate_sql` against the Python sidecar; the row in `history` is updated with valid / invalid.
15. If validation passes, the user copies the SQL and runs it in their own tool. If it fails, the user sees a structured error.

## Threading model

- The frontend is a single-page React app.
- The Rust core uses `tokio` for async IO. Database calls, LLM calls, and sidecar IPC are all async.
- The Python sidecar is a long-lived child process that communicates over stdin/stdout using newline-delimited JSON. It is started on app launch and reused.

## Persistence

- Schema cache, annotations, redactions, embeddings, history, provider configs, connection profiles, settings: a single SQLCipher-encrypted SQLite file at `<app data dir>/sql-mate/store.db`. The 32-byte key sits in `<app data dir>/sql-mate/.db-key`; OS keychain integration is deferred per ADR 0008.
- Connection profiles include the password (encrypted in the store). The original architecture called for keychain-only password storage; that's the deferred part.
- API keys: same SQLCipher store; never written to plaintext disk by us, never logged, never included in telemetry.
- Logs: structure-only (counts, timings, error types). Never schema content. Never query content. (Phase 9 polish does not yet add a log retention policy — currently the app prints to stderr and Tauri's window console, not a file.)

## What we do not have and will not add without an ADR

- Any outbound network call beyond the two listed at the top.
- Any local server listening on a port.
- Any execution code path that runs generated SQL against the user's database (Phase 9 removed it; reintroduction would be a new ADR).
- Any background sync, auto-update of schema, or telemetry payload.
- Any code that reads row data into the LLM call path.
