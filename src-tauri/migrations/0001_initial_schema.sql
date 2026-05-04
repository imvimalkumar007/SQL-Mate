-- Initial schema for the SQL Mate local store.
-- Tables defined per docs/architecture/schema-store.md.

CREATE TABLE connection_profiles (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    dialect TEXT NOT NULL,
    host TEXT NOT NULL,
    port INTEGER NOT NULL,
    database_name TEXT NOT NULL,
    username TEXT NOT NULL,
    keychain_ref TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    last_used_at INTEGER
);

CREATE TABLE schemas (
    connection_id TEXT PRIMARY KEY,
    extracted_at INTEGER NOT NULL,
    model_json TEXT NOT NULL,
    FOREIGN KEY (connection_id) REFERENCES connection_profiles(id) ON DELETE CASCADE
);

CREATE TABLE annotations (
    connection_id TEXT NOT NULL,
    schema_name TEXT NOT NULL,
    table_name TEXT NOT NULL,
    column_name TEXT,
    annotation TEXT NOT NULL,
    PRIMARY KEY (connection_id, schema_name, table_name, column_name)
);

CREATE TABLE redactions (
    connection_id TEXT NOT NULL,
    schema_name TEXT NOT NULL,
    table_name TEXT,
    column_name TEXT,
    kind TEXT NOT NULL CHECK (kind IN ('excluded', 'sensitive')),
    PRIMARY KEY (connection_id, schema_name, table_name, column_name)
);

CREATE TABLE history (
    id TEXT PRIMARY KEY,
    connection_id TEXT NOT NULL,
    asked_at INTEGER NOT NULL,
    question TEXT NOT NULL,
    generated_sql TEXT,
    validation_status TEXT NOT NULL,
    validation_error TEXT,
    was_executed INTEGER NOT NULL DEFAULT 0,
    execution_row_count INTEGER,
    execution_duration_ms INTEGER,
    FOREIGN KEY (connection_id) REFERENCES connection_profiles(id) ON DELETE CASCADE
);

CREATE TABLE settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

INSERT INTO settings (key, value) VALUES ('schema_version', '1');
