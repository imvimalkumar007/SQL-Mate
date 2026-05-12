# Schema store

Local persistence for schema models, user annotations, redaction rules, query history, and connection profiles.

## Storage location

`<app data dir>/sql-mate/store.db` — a single SQLite file, encrypted with SQLCipher.

**Key storage (ADR 0016):** On Windows, the 32-byte SQLCipher key is stored in
Windows Credential Manager under the target name `sql-mate/db-key`, encrypted
with DPAPI per user. On macOS and Linux, the key lives in
`<app data dir>/sql-mate/.db-key` with `chmod 0600`; OS keychain integration
for those platforms is a future item tracked in ADR 0016.

App data dir resolves to:
- macOS: `~/Library/Application Support/sql-mate/`
- Windows: `%APPDATA%\sql-mate\`
- Linux: `$XDG_DATA_HOME/sql-mate/` or `~/.local/share/sql-mate/`

## Tables

```sql
-- One row per database connection the user has set up
CREATE TABLE connection_profiles (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  dialect TEXT NOT NULL,
  host TEXT NOT NULL,
  port INTEGER NOT NULL,
  database_name TEXT NOT NULL,
  username TEXT NOT NULL,
  password TEXT NOT NULL,      -- DB password; encrypted at rest by SQLCipher (Phase 2). ADR 0008 defers OS-keychain storage to Phase 7.
  created_at INTEGER NOT NULL,
  last_used_at INTEGER
);

-- Latest extracted schema for each connection
CREATE TABLE schemas (
  connection_id TEXT PRIMARY KEY,
  extracted_at INTEGER NOT NULL,
  model_json TEXT NOT NULL,  -- canonical schema model serialized
  FOREIGN KEY (connection_id) REFERENCES connection_profiles(id) ON DELETE CASCADE
);

-- User-written annotations on tables and columns
CREATE TABLE annotations (
  connection_id TEXT NOT NULL,
  schema_name TEXT NOT NULL,
  table_name TEXT NOT NULL,
  column_name TEXT,  -- NULL for table-level annotations
  annotation TEXT NOT NULL,
  PRIMARY KEY (connection_id, schema_name, table_name, column_name)
);

-- Redaction rules
CREATE TABLE redactions (
  connection_id TEXT NOT NULL,
  schema_name TEXT NOT NULL,
  table_name TEXT,    -- NULL means whole schema
  column_name TEXT,   -- NULL means whole table or schema
  kind TEXT NOT NULL CHECK (kind IN ('excluded', 'sensitive')),
  PRIMARY KEY (connection_id, schema_name, table_name, column_name)
);

-- Question and SQL history. The app does not execute SQL (Phase 9), so the
-- last three columns are vestigial — they hold their default values
-- forever and are kept only because removing them would require a forward
-- migration that's not worth the cost. If execution ever returns these
-- become useful again.
CREATE TABLE history (
  id TEXT PRIMARY KEY,
  connection_id TEXT NOT NULL,
  asked_at INTEGER NOT NULL,
  question TEXT NOT NULL,
  generated_sql TEXT,
  validation_status TEXT NOT NULL,  -- 'generated', 'valid', 'invalid'
  validation_error TEXT,
  was_executed INTEGER NOT NULL DEFAULT 0,    -- vestigial; always 0
  execution_row_count INTEGER,                -- vestigial; always NULL
  execution_duration_ms INTEGER,              -- vestigial; always NULL
  FOREIGN KEY (connection_id) REFERENCES connection_profiles(id) ON DELETE CASCADE
);

-- Application settings, key-value
CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
```

## What is deliberately not stored

- Query results. The app does not execute SQL, so there are no results to store.
- Schema content from row data. We never have any.
- Telemetry events. Phase 9 ships a telemetry opt-in toggle in settings, but this build never sends a payload regardless of the flag.

## Secrets

- **Database passwords** are stored in the `connection_profiles.password` column inside the SQLCipher-encrypted store.
- **LLM API keys** are stored in `provider_configs.api_key` (one row per configured provider, added in Phase 4 with migration 0002), also inside the SQLCipher-encrypted store. Keys are read from the store at the moment of an outbound LLM request and not cached in long-lived memory.
- **The SQLCipher key itself** — see ADR 0016. On Windows: Windows Credential Manager (`sql-mate/db-key`, DPAPI-encrypted per user). On macOS/Linux: `<app data dir>/sql-mate/.db-key` with `chmod 0600`.

## Migrations

Schema versions are managed via a `schema_version` row in `settings`. Migrations are forward-only and run on app launch. Migration scripts live in `src-tauri/migrations/` and are embedded into the binary.

## Key derivation

The SQLCipher key is derived as follows (ADR 0016 implementation):

**Windows:**
1. On first launch, generate 32 bytes from a CSPRNG.
2. Save those bytes to Windows Credential Manager (`sql-mate/db-key`,
   `CRED_TYPE_GENERIC`, `CRED_PERSIST_LOCAL_MACHINE`).
3. On every subsequent launch, read the bytes from Credential Manager via
   `CredReadW` and pass to SQLCipher.
4. **Migration:** if a `.db-key` file exists from a pre-ADR-0016 install, its
   contents are moved into Credential Manager and the file is deleted
   automatically on first launch after the upgrade.

**macOS / Linux:**
1. On first launch, generate 32 bytes from a CSPRNG.
2. Write those bytes to `<app data dir>/sql-mate/.db-key` with `chmod 0600`.
3. On every subsequent launch, read the bytes from the file.

If the key is missing or corrupted, the database is unreadable and must be
reset. There is no recovery mechanism by design — recoverable encryption is not
encryption.

## Backup and export

The user can export their schema and annotations as JSON via a settings menu. Exports do not include passwords or the encryption key. They can be imported on another machine, after which the user re-enters credentials.

History export is separate and produces a JSON file with question text, generated SQL, and timing — but never results.
