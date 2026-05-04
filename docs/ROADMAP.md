# Roadmap

Milestones, in order. Each phase has a "done when" criterion. Do not start the next phase until the previous one's done-when is met.

## Phase 0 — Foundation (current)

Documentation and architecture only. No production code.

**Done when:** This `docs/` directory is reviewed and signed off. ADRs 0001–0004 are accepted.

## Phase 1 — Walking skeleton

Tauri app launches. Hardcoded schema is sent to a hardcoded Anthropic API call with a hardcoded question. Result is parsed and shown.

**Goal:** Prove the end-to-end shape works on all three target OSes (macOS, Windows, Linux).

**Done when:** A developer on each target OS can run `pnpm tauri dev`, paste an API key into a settings field, click a button, and see a SQL query generated from a stub schema.

## Phase 2 — Live schema extraction (Postgres only)

Implement the Rust schema extractor for Postgres. User pastes connection details, app connects with read-only credentials, runs the metadata queries documented in `docs/architecture/schema-extraction.md`, normalizes to the canonical schema model, persists to the local SQLite store.

**Done when:** A user can connect to a real Postgres database, see the extracted schema in the UI, and have it persisted across app restarts. End-to-end question-to-SQL works against this real schema.

## Phase 3 — Validation and execution

Wire up the Python sidecar with `sqlglot`. Generated SQL is validated for read-only before display. Add the "run query" button that executes against the user's database in a read-only transaction with a timeout and row cap.

**Done when:** The full loop works for Postgres: connect, extract, ask, see SQL, validate, run, see results. All without any row data touching the LLM call path. Validator rejects all non-`SELECT` statements in tests.

## Phase 4 — Provider abstraction

Refactor the LLM client into the provider interface documented in `docs/architecture/llm-provider.md`. First-class support for Anthropic and OpenAI. OpenAI-compatible fallback for any base URL the user provides. Model registry loaded from a static JSON file.

**Done when:** A user can switch between Anthropic, OpenAI, and a third provider (e.g., Groq via OpenAI-compatible) without restarting the app. API keys are stored in the OS keychain.

## Phase 5 — Schema retrieval for larger databases

Add embedding-based table retrieval for schemas with more than ~50 tables. Embeddings are computed locally if a local model is available, or via the configured LLM provider's embedding endpoint otherwise (still BYO key, still no row data).

**Done when:** The app generates correct SQL on a 200-table benchmark schema with quality comparable to small-schema performance.

## Phase 6 — Other dialects

Add MySQL, SQL Server, SQLite. Each requires its own extractor and dialect-aware validator settings. UI does not change meaningfully.

**Done when:** All four dialects pass the Phase 3 done-when criterion.

## Phase 7 — Redaction and annotations

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
