# Phase 1 kickoff

This document is the entry point for Claude Code's first working session. It captures the decisions confirmed in the planning conversation so Claude Code does not need to ask them again.

## Reading order

Before writing any code, read these files in order:

1. `CLAUDE.md` — working norms and security non-negotiables
2. `docs/PROJECT_BRIEF.md` — product goals and target user
3. `docs/ARCHITECTURE.md` — system design
4. `docs/SECURITY_MODEL.md` — threat model and guarantees
5. `docs/ROADMAP.md` — phased build plan, find Phase 1's done-when
6. `docs/architecture/llm-provider.md` — Phase 1 stubs the start of this module
7. `docs/decisions/0001-tauri-over-electron.md` through `0004-sqlglot-for-validation.md` — accepted ADRs

After this, you have full context.

## What Phase 1 delivers

The walking skeleton. Goal: prove the end-to-end shape works on the developer's Windows machine.

**Done when:**
- `pnpm tauri dev` launches the Tauri app
- The app has a settings field for an Anthropic API key (session-only)
- The app has a "Generate SQL" button that takes a hardcoded stub schema and a hardcoded question, calls Anthropic, and displays the returned SQL
- ADR 0005 exists at `docs/decisions/0005-reqwest-for-http.md`
- All commits land on the `phase-1/scaffold` branch with messages prefixed `phase-1: `

Phase 1 does not need: persistence, real database connections, validation, query execution, multiple providers, keychain integration, or polished UI. Those are later phases.

## Confirmed decisions for Phase 1

These were settled in planning; do not re-litigate them.

### 1. Project location
Scaffold inside the current working directory (alongside `CLAUDE.md`, `README.md`, `docs/`). Do not create a subfolder.

### 2. Frontend stack
Tauri 2.x official template: Vite + React + TypeScript + pnpm. Take the template as-is; no ADR needed.

### 3. HTTP client
`reqwest` with `rustls-tls`. Pin the exact version. Disable default features and enable only `rustls-tls` and `json`. Write ADR 0005 documenting this choice and the configuration commitment.

### 4. Model
Hardcode `claude-opus-4-7`. The default API base URL is `https://api.anthropic.com`.

### 5. API key handling
Session-only. The key lives in React state, gets passed to the Rust backend per request, and is never written to disk in Phase 1.

Two requirements on the implementation:

- The settings field must have a visible banner (yellow or amber, not subtle gray) reading: **"Phase 1 development build. API key is held in memory only, cleared on close. Keychain integration ships in a later phase."**
- Add a comment at the line where the key is read from React state and passed to Rust: `// TODO(phase-4): move to OS keychain via tauri-plugin-keyring`

### 6. Provider abstraction
Do not build the `LlmProvider` trait yet. Write a single concrete async function:

```rust
// src-tauri/src/llm/anthropic.rs
pub async fn call_anthropic(
    api_key: &str,
    schema: &str,
    question: &str,
) -> Result<String, AnthropicError> { ... }
```

Place it in `src-tauri/src/llm/anthropic.rs` (the directory `src/llm/` is where Phase 4's abstraction will live; starting there saves a refactor).

### 7. Stub schema and question for the walking skeleton
Use a small hardcoded schema for the first end-to-end test. Suggested:

```
schema: public
  customers
    id: integer [PK] [NOT NULL]
    email: varchar [NOT NULL]
    created_at: timestamp [NOT NULL]
  orders
    id: integer [PK] [NOT NULL]
    customer_id: integer [NOT NULL] [FK -> public.customers.id]
    total_cents: integer [NOT NULL]
    placed_at: timestamp [NOT NULL]

question: "How many orders did each customer place last month?"
```

The exact prompt structure should follow `docs/architecture/sql-generation.md`. The system prompt is hardcoded as a Rust string constant in Phase 1; later phases will template it.

## What to ask the developer about

Per `CLAUDE.md`, ask before:
- Adding any dependency not listed in this document
- Changing the LLM prompt structure beyond what `sql-generation.md` documents
- Persisting anything to disk in Phase 1
- Deviating from any decision in the "Confirmed decisions" section above

Do not ask about:
- Code style choices, linting rules, formatter configs (pick conventional defaults)
- Test framework choice (use `cargo test` for Rust, `vitest` for TypeScript — both conventional)
- Tauri config defaults (use the template's defaults unless they break Phase 1)

## Workflow

1. Branch is already created (`phase-1/scaffold`). Make sure you are on it: `git status`.
2. Scaffold the Tauri app per the confirmed decisions.
3. Implement the Anthropic call.
4. Wire up the UI (one settings field, one button, one display area).
5. Verify `pnpm tauri dev` works.
6. Write ADR 0005.
7. Commit incrementally with `phase-1: <what>` messages.
8. Push to `origin phase-1/scaffold`.
9. Tell the developer Phase 1 is ready for review.

The developer will open the PR, review the diff, and merge to `main` after verifying done-when criteria.

## ADR 0005 outline

When writing ADR 0005 for the HTTP client choice, follow the structure of ADRs 0001-0004 (Status, Context, Decision, Rationale, Tradeoffs accepted, Alternatives considered). Key points to cover:

- **Context:** Phase 1 needs an HTTP client for the Anthropic API call. Phase 2+ will need it for database connections too (sqlx uses it under the hood for some drivers).
- **Decision:** `reqwest` with `rustls-tls`, default features disabled, pinned version.
- **Rationale:** Async-native fits Tauri's tokio runtime; `rustls` avoids the OpenSSL dependency on Windows; minimal feature set keeps the LLM call path's dependency surface small (per `CLAUDE.md`).
- **Alternatives:** `ureq` (sync, doesn't fit tokio), Anthropic's Rust SDK (less mature than Python/TS, heavier dep for one call).

Keep it brief. The doc exists for the audit trail, not as an essay.
