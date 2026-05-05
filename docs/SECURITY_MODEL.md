# Security model

This document is the source of truth for the security claims we make to users. Any UI text, marketing copy, or documentation that describes our security posture must match what is here. If something here is wrong, fix this doc first, then propagate.

## What we guarantee

These are claims we make and that the architecture structurally enforces. A user's security team should be able to verify each of these by reading our code, our network calls, and our local file writes.

1. **Row data from your database never leaves your machine.** Not to the LLM provider, not to us, not to anywhere. The LLM call path receives only schema metadata (table and column names, types, keys, user-written descriptions). Query results are displayed locally and stored locally, never transmitted.
2. **We are not in the data path.** The application makes its LLM calls directly from your machine to the provider you configured, using the API key you provided. We do not proxy. We do not have a server. We could not see your data even if we wanted to.
3. **Generated SQL is read-only by construction.** Every query we generate is parsed and validated for read-only operations before you see it. The validator rejects any query that mutates state. This is enforced at the application layer; we recommend you also use database credentials that are read-only at the database layer.
4. **The app does not execute generated SQL.** As of the Phase 9 UX overhaul we removed the run-query path entirely. The app produces validated SQL and you copy it into your own tool to run. This is a stronger posture than "auto-execute disabled" — there is simply no execution code path inside the app.
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

**Scenario:** The LLM generates an `UPDATE`, `DELETE`, `DROP`, or similar query, and it runs against the user's database.

**Primary mitigation (Phase 9):** The app does not run generated SQL. There is no execution code path inside the application; the user copies the validated SQL out and runs it in a tool of their choice. A buggy LLM, a hostile prompt-injection, and a software bug in this app all converge on the same outcome: a SQL string sitting in the UI that does nothing until the user takes external action.

**Belt-and-suspenders mitigations that still ship:**

- **Layer 1 (Rust pre-parse):** rejects any SQL that doesn't start with `SELECT`/`WITH` or that contains forbidden mutating keywords. Catches the obvious cases before the sidecar even sees them.
- **Layer 2 (sqlglot AST in the Python sidecar):** parses the SQL, walks the tree, rejects any mutation node, system tables, denylisted functions, and references to tables or columns not in the user's actual extracted schema. Dialect-aware. See `docs/architecture/sql-validation.md`.
- **User-side recommendation:** use database credentials that are read-only at the database layer. The app surfaces this in the onboarding wizard and the security review PDF. With execution removed it is no longer load-bearing for this app, but it remains good hygiene for whatever tool the user runs the SQL in.

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

### T8: Floating widget surface (Phase 10 / ADR 0014)

**Scenario:** The Windows-only floating widget — frameless, always-on-top, summoned by a global hotkey — could be misread as something more invasive (overlay sensing, screen capture, keystroke logging) or could itself become a leak vector.

**Mitigation, by claim:**

- **The widget is a window. It does not read the screen.** No `BitBlt`, no `GraphicsCaptureSession`, no Direct3D capture surface. The Tauri capabilities manifest at `src-tauri/capabilities/default.json` lists every permission the widget has — none touch screen capture.
- **The widget does not capture keystrokes outside its own input box.** The global hotkey (`tauri-plugin-global-shortcut`) only listens for the configured combo (`Ctrl+Shift+Space` by default, rebindable in Settings) and triggers the widget's own toggle handler. No keylogger.
- **No external font CDN.** The original prototype loaded Inter, JetBrains Mono, and Material Symbols from `fonts.googleapis.com`; the shipped widget bundles inline-SVG icons (`src/widget-icons.tsx`) and uses system font fallbacks, so no outbound request to Google. The two endpoints listed at the top of `ARCHITECTURE.md` (LLM provider + user database) remain the only outbound destinations.
- **No outbound communication from the widget itself.** All Tauri commands the widget invokes are the same ones the main window invokes — `generate_sql`, `validate_sql`, `get_persisted_schema`, etc. The widget is a new view, not a new network surface.
- **`transparent: true` on the window** (so the rounded corners don't leak white) does not give the widget any visibility into what's underneath it. It just means the OS doesn't paint a backdrop in the area outside the widget's HTML shape.
- **Auto-start on Windows boot** (`tauri-plugin-autostart`, opt-in via Settings → "Start with Windows") writes a value to `HKCU\Software\Microsoft\Windows\CurrentVersion\Run` so the app launches at login. The widget itself stays hidden in the tray until summoned. No background telemetry, no eager LLM calls — same posture as the manually-launched app.

## Verification — what a security review can check

A reviewer should be able to confirm our claims by:

1. Reading `src-tauri/src/llm/` and confirming that the request payload is built only from schema metadata fields, never from any field that could carry row data.
2. Inspecting outbound network calls (e.g., with a proxy) and confirming that the only destinations are the configured LLM provider and the configured database (the model registry is bundled, not fetched).
3. Confirming that `src-tauri/src/commands.rs` has no `execute_query` Tauri command and no path that opens a database connection for query execution. The only DB connection the app opens is the metadata-only schema-extraction connection in `src-tauri/src/extract/`.
4. Reading the Python sidecar (`sidecar/main.py`) and the Rust pre-parse (`layer1_prevalidate` in `commands.rs`) and confirming the read-only enforcement logic — these still ship as defense in depth even though no execution path consumes their verdict.
5. Running the app with a deliberately malformed schema or adversarial column comments and observing that no information from those fields can cause data exfiltration.
6. Inspecting log files after extended use and confirming no schema or query content is present.
7. Exporting the security review PDF (Settings → Security review pack → Export) and verifying every claim in it against the live state.
8. Reading `src-tauri/capabilities/default.json` and confirming that the widget's permission list (Phase 10) is bounded to window control (`set-size`, `set-position`, `show`, `hide`, `set-focus`, `is-visible`, `unminimize`), event listening, the global-shortcut allow-list, and the autostart allow-list. No screen-capture or input-injection permissions.
9. Inspecting `src/widget.html` and `src/Widget.tsx` and confirming no third-party script tags, no `<link rel="stylesheet" href="https://...">`, no `fetch()` to anywhere except the existing Tauri command surface.

## Disclosure

Security issues should be disclosed to (placeholder — replace before launch). We commit to acknowledging within 72 hours and to publishing a fix or mitigation timeline within two weeks.
