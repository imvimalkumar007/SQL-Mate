-- Durable request log. See ADR 0018.
-- Each row is one generate_sql call. The user_message is the post-obfuscation
-- schema text + question block that was actually sent to the LLM.

CREATE TABLE request_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    connection_id TEXT NOT NULL,
    timestamp INTEGER NOT NULL,
    model TEXT NOT NULL,
    provider_kind TEXT NOT NULL,
    system_prompt TEXT NOT NULL,
    user_message TEXT NOT NULL,
    obfuscated_columns INTEGER NOT NULL DEFAULT 0,
    excluded_tables TEXT NOT NULL DEFAULT '[]'
);

CREATE INDEX request_log_connection_ts ON request_log (connection_id, timestamp DESC);

REPLACE INTO settings (key, value) VALUES ('schema_version', '5');
