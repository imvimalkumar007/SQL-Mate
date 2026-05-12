# Glossary

Terms used throughout the project that have a specific meaning here. When in doubt, use these definitions.

**Canonical schema model.** The intermediate representation of a database schema used internally. Defined in `docs/ARCHITECTURE.md` under "Canonical schema model." Every ingestion path produces this; every consumer reads this.

**Dialect.** The flavor of SQL spoken by a specific database. Postgres, MySQL, SQL Server, SQLite, Snowflake, BigQuery, Redshift. Validation, extraction, and prompt composition are all dialect-aware.

**Excluded entity.** A schema, table, or column that the user has marked as off-limits. Excluded entities are never included in any LLM request and never queryable through the app.

**Extraction.** The process of obtaining a schema model. Live extraction means connecting to a database and running metadata queries. File-based extraction (out of scope for v1) means parsing a SQL DDL, PDF, or SVG file.

**LLM call path.** The code path that ends in an HTTPS request to an LLM provider. Subject to the strictest review because anything that lands here leaves the user's machine.

**Provider.** An LLM service (Anthropic, OpenAI, Google, etc.) or any service exposing an OpenAI-compatible API. Configured by the user with their own API key.

**Read-only transaction.** Historically: a database transaction explicitly marked read-only at the database protocol level (Postgres `SET default_transaction_read_only`, MySQL `SET SESSION TRANSACTION READ ONLY`, etc.). Phase 9 removed in-app SQL execution, so the only DB connection the app opens now is the schema-extraction connection in `extract::*`, which uses the same read-only setting belt-and-suspenders even though the metadata query is inherently read.

**Redaction.** The process of replacing sensitive table or column names with obfuscated identifiers before sending to the LLM, and reversing that mapping when the response comes back. Per-entity, opt-in.

**Schema slice.** The subset of the canonical schema model included in a single LLM request. For small databases this is the whole schema. For large ones it is the relevant tables selected by the retriever, plus their foreign-key neighbors.

**Sensitive entity.** A schema, table, or column that the user has marked as sensitive but not excluded. Included in LLM requests with an obfuscated name. Distinct from excluded.

**Sidecar.** The Python child process that hosts `sqlglot` for SQL validation. Long-lived, communicates with the Rust core over stdin/stdout JSON.

**Validator.** The module that parses generated SQL and enforces read-only and schema-grounded constraints. Implemented partly in Rust (fast first-pass) and partly in the Python sidecar (`sqlglot` AST analysis). The validator's verdict gates whether the SQL is shown to the user.

**Request log.** An in-memory record of the most recent generation request per connection — the post-obfuscation user message exactly as sent to the LLM. Used by the UI to let the user audit what bytes went to the provider. Cleared on app restart; never persisted.

**Session history.** An in-memory list of past question + generated-SQL pairs from the current app session. Rendered below the current generated SQL. Cleared on restart. (The persisted `history` table is a separate thing, surfaced via `list_history` for any future cross-session UI.)

**Widget.** The Windows-only floating window introduced in Phase 10 (ADR 0014). Frameless, always-on-top, no taskbar entry, summoned by a global hotkey or by left-clicking the system tray icon. Reuses the same backend (`generate_sql`, `validate_sql`, etc.) as the main window — it's a new view, not a new code path. macOS and Linux are deferred.

**Pill.** The collapsed form of the widget — a 220×30 rounded shape showing the connection name, model name, and an expand chevron. The user collapses to the pill via the header's collapse button; clicks the chevron button to expand back. The pill body is the drag region (so users can move the pill around the desktop), and the chevron is a real `<button>` so its click reaches React without the drag region intercepting the event.

**Widget hotkey.** The global keyboard shortcut that toggles widget visibility from anywhere on Windows. `Ctrl+Shift+Space` by default, rebindable in Settings → Widget. Registered via `tauri-plugin-global-shortcut`. If registration fails (another app already owns the combo), the error is written to `widget_hotkey_error` in the `settings` table and surfaced as a banner in Settings.

**Widget state.** A single-row table (`widget_state`) in the SQLCipher store holding last position, last question, last SQL, last validation status, and the `pill_mode` flag. Position and `pill_mode` persist indefinitely; the question / SQL / validation columns are cleared on read if the row is more than 24 hours old.

**Connection picker.** The multi-database switcher in the widget header, introduced in Phase 11 (ADR 0015). Appears only when more than one connection profile exists. Clicking the active connection name opens a fixed-position overlay listing all saved profiles with their schema age and a per-profile refresh button. Selecting a different profile switches the widget's active connection inline, without leaving the widget or restarting the app.

**Stale SQL.** SQL that was generated against a different connection profile than the one currently active in the widget. When the user switches connections mid-session (via the connection picker), any previously generated SQL is retained on screen but rendered at reduced opacity (`opacity: 0.45`) with a "from previous connection" notice, and the copy button is disabled. Generating a new question clears the stale state.

