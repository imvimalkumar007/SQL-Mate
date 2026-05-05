# CLAUDE.md

This file gives Claude Code the working context it needs to be effective on this project across sessions. Read this first in any new session.

## What this project is

A local-first desktop app that turns natural-language questions into SQL queries against a user's database, without exposing row data to any LLM or to our infrastructure. Read `docs/PROJECT_BRIEF.md` for the full product brief.

## Non-negotiables

These are not preferences. They are product-defining constraints. Do not relax them for convenience.

1. **Row data never leaves the user's machine.** Not to the LLM, not to telemetry, not to logs, not anywhere. If you find yourself writing code that ships row data off-device, stop and reconsider.
2. **All LLM calls use the user's own API key.** We do not proxy LLM requests. We do not add a server in the middle. The HTTP request goes from the user's machine directly to the provider they chose.
3. **Generated SQL is read-only by construction.** Validate the AST before showing it to the user. Reject `INSERT`, `UPDATE`, `DELETE`, `DROP`, `TRUNCATE`, `ALTER`, `CREATE`, `GRANT`, `EXECUTE`, `MERGE`, `CALL`, and `SELECT ... INTO`. Reject CTEs that wrap mutations. Read `docs/architecture/sql-validation.md`.
4. **Database credentials must be read-only at the database level.** Application-level checks are defense in depth, not the primary control. Document this clearly to users; provide setup snippets per dialect.
5. **Secrets are encrypted at rest, never in plaintext.** As of Phase 2, secrets (API keys, DB passwords, SQLCipher key reference) live in the SQLCipher-encrypted local SQLite store, with the SQLCipher key in a sibling file under the app data dir. The longer-term target is OS keychain (macOS Keychain / Windows Credential Manager / Linux Secret Service) — see ADR 0008 for the deferral. Either way: never in plaintext config files, never alongside logs, never in any telemetry payload.
6. **No telemetry without explicit opt-in.** Default off. Opt-in pings are anonymous and never include schema names, query text, or any database content.

If a task seems to require violating one of these, raise it before writing code. There is almost always a different design that satisfies the constraint.

## How to work in this repo

### Before making changes
- Re-read the relevant doc under `docs/architecture/` for the module you are touching.
- Check `docs/decisions/` for any ADR that constrains the approach.
- If the change crosses a module boundary or affects the security model, draft an ADR before implementing.

### When making changes
- Keep modules small and behind clean interfaces. The provider abstraction, schema extractor, and validator should each be replaceable.
- Prefer Rust for anything that touches the database or the file system. Use the Python sidecar only for `sqlglot`-based validation, which has no good Rust equivalent yet.
- Frontend state should be ephemeral. Persistent state (schema cache, history) goes through the Rust backend, which writes to the local SQLite file.
- All user-facing strings that mention security guarantees must match `docs/SECURITY_MODEL.md`. If the doc and the UI disagree, fix one to match the other and note it in the PR.

### When finishing changes
- Update the relevant `docs/architecture/*.md` if behavior or interfaces changed.
- If you made an architectural decision, add an ADR under `docs/decisions/` numbered sequentially.
- Update `docs/ROADMAP.md` if you completed or reshaped a milestone.

## Style and tone

- Sentence case in commit messages, doc headings, and UI strings. Never Title Case.
- Plain language. The audience for our docs and our UI is a security-cautious data engineer, not a marketing reader.
- When you're uncertain, say so in code comments and PR descriptions. Hedging is better than false confidence in a tool with this security posture.

## What to ask the user about

Ask before:
- Adding a new external dependency (network call, new crate, new npm package over a few KB).
- Changing the LLM prompt structure in a way that materially changes what we send to the provider.
- Changing what gets persisted to local storage.
- Loosening any of the non-negotiables above for any reason.

Don't ask, just do:
- Refactoring within a module to match the documented interface.
- Adding tests.
- Fixing typos, dead code, lint warnings.
- Updating doc files to match implemented behavior.

## Common pitfalls on this project

- **Forgetting that "schema" includes column names.** Column names can leak business logic (`internal_churn_risk_score`). Some users will redact them before any LLM sees them. The redaction layer must work end-to-end; don't bypass it in dev.
- **Reintroducing in-app SQL execution.** Phase 9 removed it. If you find yourself writing code that opens a DB connection outside the schema-extraction module, stop — the security claim "the app does not execute generated SQL" is load-bearing and any change there needs an ADR. See `docs/architecture/query-execution.md`.
- **Storing the API key in app state.** Read it from the keychain at the moment of the request, never cache it in a long-lived variable.
- **Accidentally logging schema content.** Logs go to the user's disk but are still a leak vector if the machine is compromised. Log structure, not content. `Extracted 24 tables` is fine; `Extracted tables: customers, orders, ...` is not.

## When in doubt

Default to the more conservative choice on anything touching security or data flow. The product's value is the security posture; eroding it for a UX win is a bad trade.
