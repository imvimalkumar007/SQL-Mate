# Roadmap

Milestones, in order. Each phase has a "done when" criterion. Do not start the next phase until the previous one's done-when is met.

## Phase 0 — Foundation (done)

Documentation and architecture only. No production code.

**Done when:** This `docs/` directory is reviewed and signed off. ADRs 0001–0004 are accepted.

## Phase 1 — Walking skeleton (done)

Tauri app launches. Hardcoded schema is sent to a hardcoded Anthropic API call with a hardcoded question. Result is parsed and shown.

**Goal:** Prove the end-to-end shape works on all three target OSes (macOS, Windows, Linux).

**Done when:** A developer on each target OS can run `pnpm tauri dev`, paste an API key into a settings field, click a button, and see a SQL query generated from a stub schema. — Verified end-to-end on Windows. macOS and Linux verification deferred until those machines are available; see `PHASE_1_LOG.md` for the build log.

## Phase 2 — Live schema extraction (Postgres only) (done)

Implement the Rust schema extractor for Postgres. User pastes connection details, app connects with read-only credentials, runs the metadata queries documented in `docs/architecture/schema-extraction.md`, normalizes to the canonical schema model, persists to the local SQLite store.

**Done when:** A user can connect to a real Postgres database, see the extracted schema in the UI, and have it persisted across app restarts. End-to-end question-to-SQL works against this real schema. — Verified end-to-end on Windows against a local Postgres 17.9 instance with a 4-table seed schema. OS keychain integration deferred per ADR 0008; see PHASE_2_LOG.md for the build log.

## Phase 3 — Validation and execution (done)

Wire up the Python sidecar with `sqlglot`. Generated SQL is validated for read-only before display. Add the "run query" button that executes against the user's database in a read-only transaction with a timeout and row cap.

**Done when:** The full loop works for Postgres: connect, extract, ask, see SQL, validate, run, see results. All without any row data touching the LLM call path. Validator rejects all non-`SELECT` statements in tests. — Verified end-to-end on Windows: Python 3.14 sidecar with `sqlglot==30.7.0`, layer-1 Rust pre-parse, layer-2 sqlglot AST walk, executor running in a `default_transaction_read_only` enforced transaction with 1000-row cap and 30 s timeout. See `PHASE_3_LOG.md`.

## Phase 4 — Provider abstraction (done)

Refactor the LLM client into the provider interface documented in `docs/architecture/llm-provider.md`. First-class support for Anthropic and OpenAI. OpenAI-compatible fallback for any base URL the user provides. Model registry loaded from a static JSON file.

**Done when:** A user can switch between Anthropic, OpenAI, and a third provider (e.g., Groq via OpenAI-compatible) without restarting the app. API keys are stored in the SQLCipher-encrypted local store. (The original done-when called for OS keychain storage; deferred to Phase 7 per ADR 0008. Closed enum dispatch instead of `Box<dyn LlmProvider>` per ADR 0010.) See `PHASE_4_LOG.md` for the build log.

## Phase 5 — Schema retrieval for larger databases (done — code path)

Add embedding-based table retrieval for schemas with more than ~50 tables. Embeddings are computed locally if a local model is available, or via the configured LLM provider's embedding endpoint otherwise (still BYO key, still no row data).

**Done when:** The app generates correct SQL on a 200-table benchmark schema with quality comparable to small-schema performance. — Phase 5 ships the **path** end to end: provider-endpoint embeddings (OpenAI / OpenAI-compatible), JSON-stored vectors, brute-force cosine, top-20 + FK neighborhood expansion, integration with `generate_sql`. The 200-table quality benchmark is genuinely deferred to Phase 9 (first five users) because we don't have a 200-table schema or a labeled question set to measure against. Local embedding model is a follow-up. See ADR 0011 and `PHASE_5_LOG.md`.

## Phase 6 — Other dialects (done — Postgres + MySQL; SQLite + SQL Server deferred)

Add MySQL, SQL Server, SQLite. Each requires its own extractor and dialect-aware validator settings. UI does not change meaningfully.

**Done when:** All four dialects pass the Phase 3 done-when criterion. — Phase 6 ships **MySQL** end-to-end (extractor, dispatcher, dialect dropdown). SQLite is deferred until the `sqlx-sqlite` × `rusqlite + bundled-sqlcipher` linker conflict is investigated; SQL Server is deferred until there's a real SQL Server to test against and a willingness to onboard `tiberius`. See ADR 0012 and `PHASE_6_LOG.md` for the named revisit conditions.

## Phase 7 — Redaction and annotations (current)

User can mark tables, columns, or schemas as excluded or sensitive. Sensitive entities are sent to the LLM with obfuscated names and de-obfuscated on the way back. User can write annotations on tables and columns that get included in the prompt to improve generation quality.

**Done when:** A user can extract a schema, mark three tables as excluded and two columns as sensitive, ask a question, and verify in the request log that the excluded tables are absent and the sensitive columns are obfuscated.

## Phase 8 — Polish and packaging

Signed installers for macOS (notarized), Windows (Authenticode), Linux (AppImage and deb). First-run onboarding flow. In-app documentation pack for security review. Settings UI for telemetry opt-in.

**Done when:** A user can download the app from a clean machine, install it, follow onboarding to a working query, and the security team has a single PDF they can review.

## Phase 9 — First five users

Get five target users (regulated mid-market data engineers) using the app weekly. Iterate based on what they actually struggle with. Do not add features that no user asked for.

**Done when:** Five users have used the app every week for four consecutive weeks. We have written notes on the top three friction points from each.

## Out of scope for v1

These come after phase 9 if the product has traction.

- Team mode / shared annotations
- Audit log export for enterprise
- Saved query library
- File-based schema ingestion (PDF, SVG, SQL DDL upload)
- Self-hosted LLM first-class UI
- Mobile or web companion
- Auto-updating schema on a schedule
