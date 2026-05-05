# Schema store

Local persistence for schema models, user annotations, redaction rules, query history, and connection profiles.

## Storage location

`<app data dir>/sql-mate/store.db` — a single SQLite file, encrypted with SQLCipher. The encryption key is loaded from `<app data dir>/sql-mate/.db-key` (32 random bytes generated on first launch). The original spec called for the key to be derived from a value held in the OS keychain; that integration is deferred per ADR 0008 and revisited in Phase 7.

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

-- Question and SQL history. Results are NOT stored here; only the question and generated SQL.
CREATE TABLE history (
  id TEXT PRIMARY KEY,
  connection_id TEXT NOT NULL,
  asked_at INTEGER NOT NULL,
  question TEXT NOT NULL,
  generated_sql TEXT,
  validation_status TEXT NOT NULL,  -- 'pending', 'passed', 'failed'
  validation_error TEXT,
  was_executed INTEGER NOT NULL DEFAULT 0,
  execution_row_count INTEGER,
  execution_duration_ms INTEGER,
  FOREIGN KEY (connection_id) REFERENCES connection_profiles(id) ON DELETE CASCADE
);

-- Application settings, key-value
CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
```

## What is deliberately not stored

- Query results. Held in frontend state for the duration of the session, never persisted.
- Schema content from row data. We never have any.

## Secrets

- **Database passwords** are stored in the `connection_profiles.password` column inside the SQLCipher-encrypted store (Phase 2). Original spec was OS keychain; deferred per ADR 0008.
- **LLM API keys** are stored in the `settings` table under key `anthropic_api_key`, also inside the SQLCipher-encrypted store. Same deferral as above.
- **The SQLCipher key itself** is in `<app data dir>/sql-mate/.db-key`, sitting next to the encrypted store with normal user-mode ACLs. Rebuilding the keychain story is a Phase 7 follow-up.

## Migrations

Schema versions are managed via a `schema_version` row in `settings`. Migrations are forward-only and run on app launch. Migration scripts live in `src-tauri/migrations/` and are embedded into the binary.

## Key derivation

The SQLCipher key is derived as follows (Phase 2 implementation; ADR 0008 commits us to revisit in Phase 7):

1. On first launch, generate 32 bytes from a CSPRNG.
2. Write those bytes to `<app data dir>/sql-mate/.db-key`.
3. On every subsequent launch, read the bytes from the file and pass to SQLCipher.

If the key file is missing or corrupted, the database is unreadable and the user must reset it. We do not provide a recovery mechanism beyond reset, by design — recoverable encryption is not encryption.

The intended longer-term scheme stores the key in the OS keychain (`(sql-mate, db-key)`); see ADR 0008 for why we deferred and what would unblock the migration.

## Backup and export

The user can export their schema and annotations as JSON via a settings menu. Exports do not include passwords or the encryption key. They can be imported on another machine, after which the user re-enters credentials.

History export is separate and produces a JSON file with question text, generated SQL, and timing — but never results.
