# Security model

This document is the source of truth for the security claims we make to users. Any UI text, marketing copy, or documentation that describes our security posture must match what is here. If something here is wrong, fix this doc first, then propagate.

## What we guarantee

These are claims we make and that the architecture structurally enforces. A user's security team should be able to verify each of these by reading our code, our network calls, and our local file writes.

1. **Row data from your database never leaves your machine.** Not to the LLM provider, not to us, not to anywhere. The LLM call path receives only schema metadata (table and column names, types, keys, user-written descriptions). Query results are displayed locally and stored locally, never transmitted.
2. **We are not in the data path.** The application makes its LLM calls directly from your machine to the provider you configured, using the API key you provided. We do not proxy. We do not have a server. We could not see your data even if we wanted to.
3. **Generated SQL is read-only by construction.** Every query we generate is parsed and validated for read-only operations before you see it. The validator rejects any query that mutates state. This is enforced at the application layer; we additionally require you to use database credentials that are read-only at the database layer.
4. **You see every query before it runs.** We never auto-execute a generated query. The query is displayed in the UI with an explanation of what it does, and you click run.
5. **Your API keys and database passwords are stored encrypted at rest on your machine.** As of Phase 2, secrets live in a SQLCipher-encrypted local SQLite file (AES-256-CBC, key in a sibling file). The original spec called for the OS keychain (macOS Keychain, Windows Credential Manager, Linux Secret Service); that integration is deferred and tracked in ADR 0008. We never log keys, transmit them, or include them in telemetry.
6. **No telemetry by default.** If you opt in, telemetry pings contain only anonymous usage counts and never include schema names, query text, or any database content.

## What we do not guarantee

It would be dishonest to claim things our architecture cannot actually deliver. The following are explicitly *not* guaranteed:

- **The LLM provider's data handling.** What Anthropic, OpenAI, Google, or any other provider does with the schema metadata you send them is governed by their terms, not ours. We surface their published retention policies in the UI to help you choose, but we are not the source of truth on those policies.
- **Protection from a compromised local machine.** If an attacker has code execution on your machine, all bets are off — they can read the keychain, the SQLite cache, your database connection, and your filesystem regardless of what we do.
- **Schema name confidentiality.** The schema metadata we send to the LLM includes table and column names. If your schema name itself reveals sensitive information (e.g., a table called `pending_acquisition_targets`), that name will be in the LLM request. We provide a redaction layer for this case; using it is your choice.

## Threat model

These are the threats we design against, in priority order.

### T1: Sensitive data exfiltration via the LLM call path

**Scenario:** Row data from a sensitive column ends up in the LLM request because the application sent it deliberately or accidentally.

**Mitigation:** No code path inside the application reads row data into the LLM request. The schema model has no field for sample values. Tests assert that the LLM request payload contains only schema metadata. If sample-value awareness is ever added in a future version, it must go through a separate, opt-in code path with its own user confirmation.

### T2: Destructive SQL executed against the user's database

**Scenario:** The LLM generates an `UPDATE`, `DELETE`, `DROP`, or similar query, and it runs.

**Mitigation, layer 1 (database):** We require users to configure read-only database credentials and provide setup snippets per dialect. This is the primary control.

**Mitigation, layer 2 (application):** Every generated query is parsed by `sqlglot` and rejected if it is not a pure `SELECT`. The validator is dialect-aware. See `docs/architecture/sql-validation.md` for the exact list of rejected statement types and why.

**Mitigation, layer 3 (UI):** Queries are never auto-run. The user clicks run after reviewing.

### T3: Prompt injection via ingested content

**Scenario:** A malicious actor places adversarial text in a database column comment, table description, or any other field that gets included in the schema. When the schema is sent to the LLM, that text is interpreted as instructions, causing the LLM to generate malicious SQL or to leak the schema in unexpected ways.

**Mitigation:** Schema content is structurally separated from instructions in the prompt. The system prompt and user question are clearly delimited from schema metadata. The validator catches any generated SQL that references tables or columns not in the user's actual schema, which catches the most likely outcomes of injection (queries against `information_schema` or system tables, or made-up table names).

### T4: API key exfiltration

**Scenario:** A user's LLM API key is read by malware, by another application on their machine, or by us.

**Mitigation:** Keys are stored in the SQLCipher-encrypted local store (Phase 2). We read the key from the store only at the moment of an outbound LLM request and do not cache it in long-lived memory. We never log keys. We never include keys in error messages or telemetry. The original mitigation called for the OS keychain; ADR 0008 defers that to Phase 7. The threat profile is weakened: an attacker with read access to the user's app data directory has both the encrypted store and the SQLCipher key file. A real keychain would raise the bar to OS-level credential access.

### T5: Data leak via logs

**Scenario:** Logs on the user's disk contain schema names, query text, or query results. A subsequent compromise of the machine exposes them.

**Mitigation:** We log structure, not content. Allowed log content: counts (`24 tables extracted`), timings (`extraction took 1.2s`), error types (`validation failed: write statement detected`). Disallowed: any table name, column name, query text, or row data. Reviewed at every PR that touches logging.

### T6: Schema name leakage in requests

**Scenario:** A user's schema includes table or column names that themselves are sensitive (revealing internal projects, customer identifiers, etc.).

**Mitigation:** The redaction layer lets users mark tables, columns, or whole schemas as excluded or sensitive before any LLM call. Excluded entities are never included in the prompt. Sensitive entities are included with their type and key relationships but with an obfuscated name (e.g., `table_a3f.column_2`), and the LLM's response is post-processed to reverse the obfuscation before showing the SQL to the user. This feature is opt-in per entity.

### T7: Compromised dependency

**Scenario:** A library we depend on is updated maliciously and ships an update that exfiltrates data.

**Mitigation:** We pin exact versions of all dependencies in `Cargo.lock`, `package-lock.json`, and the Python sidecar's lockfile. We minimize the number of dependencies, especially in the LLM call path. We do not auto-update dependencies. Releases are signed.

## Verification — what a security review can check

A reviewer should be able to confirm our claims by:

1. Reading `src-tauri/src/llm/` and confirming that the request payload is built only from schema metadata fields, never from any field that could carry row data.
2. Inspecting outbound network calls (e.g., with a proxy) and confirming that the only destinations are the configured LLM provider, the configured database, and the model registry URL.
3. Reading `src-tauri/src/validator/` and the Python sidecar and confirming the read-only enforcement logic.
4. Running the app with a deliberately malformed schema or adversarial column comments and observing that no information from those fields can cause data exfiltration.
5. Inspecting log files after extended use and confirming no schema or query content is present.

## Disclosure

Security issues should be disclosed to (placeholder — replace before launch). We commit to acknowledging within 72 hours and to publishing a fix or mitigation timeline within two weeks.
