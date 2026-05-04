# UI flows

The end-to-end flows that span multiple modules. Each is described from the user's point of view, with the modules involved.

## First-run setup

1. User installs and launches the app.
2. Welcome screen with three things: "What this is" (one paragraph), "What stays on your machine" (the security guarantees from `docs/SECURITY_MODEL.md`, abbreviated), and "Let's set up your first connection."
3. User clicks continue.
4. Connection setup screen. User picks a dialect, enters host/port/database/username/password, picks a friendly name. App tests the connection (a single `SELECT 1`). On success, password is written to the OS keychain and the connection profile is saved.
5. App offers to extract the schema now or later. If now: extraction runs, summary is displayed.
6. LLM provider setup screen. User picks a provider, enters an API key, picks a model. App tests with a single 1-token request to verify the key works.
7. App lands on the main screen.

Modules involved: schema-extraction, schema-store, llm-provider.

## Asking a question

1. User types a question into the prompt box on the main screen.
2. UI shows "thinking" state.
3. Backend retrieves the relevant schema slice.
4. Backend reads the API key from the keychain.
5. Backend sends the request to the LLM provider.
6. UI streams the explanation as it arrives (where the provider supports streaming).
7. SQL block is shown with syntax highlighting.
8. Validator runs (this is fast, usually under 100ms).
9. If validation fails, UI shows a structured error with the option to "Ask again, telling the model what went wrong" (which sends a follow-up message to the same conversation).
10. If validation passes, UI shows a "Run query" button alongside the SQL.
11. User can edit the SQL before running. Edits trigger re-validation on every change (debounced).

Modules involved: sql-generation, llm-provider, sql-validation.

## Running a query and viewing results

1. User clicks "Run query."
2. Backend executes the SQL against the user's database in a read-only transaction.
3. Results stream into a virtualized grid in the UI.
4. Below the grid: row count, execution time, "export to CSV" button.
5. User can click any cell to see the full value (useful for long text fields).
6. User can click "Ask a follow-up" to start a new question with this query as context for the model.

Modules involved: query-execution.

## Reviewing and editing extracted schema

1. User opens the schema panel.
2. UI shows a tree: schemas → tables → columns.
3. For each table or column, the user can:
   - Add an annotation ("This is the canonical customer record. Use this not the legacy `cust` table.")
   - Mark as excluded (never included in any LLM call)
   - Mark as sensitive (included with obfuscated name)
4. Changes are persisted to the schema store immediately.
5. A summary at the top: "24 tables visible, 3 excluded, 2 sensitive."

Modules involved: schema-store.

## Re-extracting schema

1. User opens connection settings.
2. Clicks "Re-extract schema."
3. Confirmation dialog: "This will replace the cached schema. Annotations and redaction rules will be preserved where the table or column still exists."
4. Extraction runs.
5. Diff is shown: "5 tables added, 2 removed, 3 columns changed type." User can review before accepting.
6. On accept, the new schema replaces the old one. Annotations and redaction rules are reapplied where the entity still exists. Orphaned annotations are listed for the user to handle.

Modules involved: schema-extraction, schema-store.

## Switching LLM provider mid-session

1. User opens provider settings.
2. Picks a different provider or model.
3. Tests connection.
4. Saves.
5. The next question uses the new provider. No app restart, no data migration.

Modules involved: llm-provider.

## Reviewing history

1. User opens the history panel.
2. List of past questions, sorted newest first.
3. Each entry shows: question, generated SQL (collapsed), validation status, execution status, row count if executed.
4. Clicking an entry expands it. The user can re-run the query (re-validates and re-executes; results may differ if the underlying data changed).
5. Results are not stored, so re-running is the only way to see them.

Modules involved: schema-store, sql-validation, query-execution.

## Exporting for security review

1. User opens settings → "Security review pack."
2. App generates a PDF containing:
   - The full security model from `docs/SECURITY_MODEL.md`
   - The user's current configuration: which provider, which database, what is excluded/sensitive
   - A network endpoints summary: every URL the app will contact, with frequency
   - The exact SQL queries used for schema extraction (so a DBA can verify they only read metadata)
3. User can hand this PDF to their security team.

Modules involved: all.
