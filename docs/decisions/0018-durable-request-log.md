# ADR 0018: Durable request log in the encrypted store

## Status

Accepted.

## Context

Phase 8 introduced a `RequestLog` backed by a `HashMap<String, RequestLogEntry>` in process
memory. It captures the exact prompt sent to the LLM provider for each `generate_sql` call,
including the post-obfuscation schema text and the list of excluded tables. The user can inspect
this to audit what the LLM actually saw.

The in-memory implementation has two gaps:

1. The log is lost on app restart. A user who wants to audit a query they ran yesterday cannot.
2. Only the last entry per connection is retained. If the user asked two questions in the same
   session, only the second entry is kept.

Both gaps matter for security-conscious users (data teams at regulated firms) who want an
auditable record of what left their machine. The SECURITY_MODEL.md claim "auditable in the
request log" is currently weaker than it sounds.

## Decision

Persist request log entries to the SQLCipher-encrypted local store in a new `request_log`
table. Each entry is a full row including connection ID, timestamp, model, provider kind,
system prompt, user message (post-obfuscation), obfuscated column count, and excluded table
names (as a JSON array).

Keep the existing in-memory `RequestLog` for the live session view. `generate_sql` calls
both: `request_log.record()` for the in-session cache and `store.persist_request_log_entry()`
for durability.

Expose two Tauri commands: `get_request_log(connection_id, limit)` for the frontend audit
view, and `export_request_log_json()` for full download (all connections, all entries).

Add a UI affordance: an "Audit log" button in the footer bar that opens a modal with the
last 20 entries for the active connection.

## Retention and size

Each entry is roughly 1-2 KB (schema text is the bulk). 1,000 entries is roughly 1-2 MB,
well within the range where the SQLCipher store stays fast. No automatic pruning in this
version; the user can clear the log via `clear_request_log()` if needed. A future phase
can add a configurable retention window.

## Design change: ephemeral to durable

The Phase 8 design was ephemeral by intent. The log cleared on app restart so that nothing
about past LLM interactions remained at rest. That was a deliberate posture: minimise what
persists on the user's machine beyond the schema cache and query history.

This ADR changes that posture. Prompt content now sits at rest in the encrypted store
permanently until the user clears it. The content is schema-derived (table and column names,
types, user questions) and never includes row data, but it does include schema names, which
can themselves be sensitive for some users. The tradeoff: auditability gained, persistence
cost accepted. Users who want the old ephemeral behaviour can clear the log at any time; a
future phase can add a configurable retention window.

## Consequences

- Audit trail survives app restart, satisfying the SECURITY_MODEL.md claim more completely.
- Schema metadata and user questions now sit at rest in the encrypted SQLCipher store. The
  threat model is unchanged: the log is inside the same store as the schema cache and history.
  If the SQLCipher key is compromised the log content is also exposed. Gaining that key on
  Windows requires extracting the Windows Credential Manager secret (ADR 0016).
- The per-generate-sql codepath now makes two writes: in-memory + SQLite. The SQLite write
  is synchronous (single Mutex on the Store) but small, so the extra latency is negligible
  compared to the LLM round-trip.
- The export command returns a JSON blob, which the frontend downloads as a file. No new
  network destination is introduced.
