-- Provider configurations for the LLM abstraction (Phase 4).
-- See docs/decisions/0010-llm-provider-abstraction.md.

CREATE TABLE provider_configs (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('anthropic', 'openai', 'openai_compatible')),
    base_url TEXT NOT NULL,
    model TEXT NOT NULL,
    -- API key, encrypted at rest by SQLCipher. ADR 0008 defers OS keychain to Phase 7.
    api_key TEXT NOT NULL,
    created_at INTEGER NOT NULL
);

UPDATE settings SET value = '2' WHERE key = 'schema_version';
