-- Per-table embeddings used by the retriever for >50-table schemas (Phase 5).
-- See docs/decisions/0011-embedding-based-schema-retrieval.md.

CREATE TABLE schema_embeddings (
    connection_id TEXT NOT NULL,
    qualified_table TEXT NOT NULL,
    embedding TEXT NOT NULL,
    model TEXT NOT NULL,
    dimensions INTEGER NOT NULL,
    embedded_at INTEGER NOT NULL,
    PRIMARY KEY (connection_id, qualified_table),
    FOREIGN KEY (connection_id) REFERENCES connection_profiles(id) ON DELETE CASCADE
);

UPDATE settings SET value = '3' WHERE key = 'schema_version';
