-- Phase 10: floating widget state.
--
-- Persists widget position, last question, and last generated SQL across app
-- restarts. Single-row table — there's only one widget. The PK is fixed at
-- 'singleton' so INSERT OR REPLACE always operates on the same row.
--
-- See docs/decisions/0014-floating-widget-windows.md and
-- docs/PHASE_10_KICKOFF.md.

CREATE TABLE widget_state (
    id TEXT PRIMARY KEY DEFAULT 'singleton' CHECK (id = 'singleton'),
    position_x INTEGER,
    position_y INTEGER,
    last_question TEXT,
    last_sql TEXT,
    last_model TEXT,
    last_validation_status TEXT,
    last_validation_error TEXT,
    pill_mode INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL
);

INSERT INTO widget_state (id, updated_at)
VALUES ('singleton', strftime('%s', 'now'));

UPDATE settings SET value = '4' WHERE key = 'schema_version';
