# ADR 0011: Embedding-based schema retrieval for large schemas

## Status

Accepted.

## Context

`docs/architecture/sql-generation.md` describes a two-mode schema-slice
strategy: under ~50 tables we pass the full schema; over 50, an embedding
retriever picks the top-N tables by similarity to the question and expands
via foreign-key neighborhood. Phase 5 is where that retriever lands.

Decisions to make:

1. Where do embeddings come from — the active LLM provider's endpoint, or a
   bundled local model?
2. How are embeddings stored?
3. What's the similarity-search algorithm and how big can it scale before we
   need a real vector index?
4. When does the retriever activate?
5. How do we measure quality on a 200-table benchmark schema?

## Decisions

### 1. Provider-endpoint embeddings, no local model in Phase 5

The retriever calls the active LLM provider's `/v1/embeddings` endpoint
when one exists. Phase 5 supports:

- **OpenAI** — `text-embedding-3-small` (1536 dimensions) by default.
- **OpenAI-compatible** — same endpoint shape, configurable via the same
  `provider_configs` row used for chat completions.

Anthropic does not offer an embeddings API. If the active provider config
is `kind = anthropic`, the embed action returns a clear error: "configure an
OpenAI-or-compatible provider for embeddings." The user needs a second
provider config in this case.

A bundled local embedding model (e.g., `fastembed` with `bge-small-en`) is
a Phase 5 follow-up. The reasons we deferred it:

- ~30 MB binary-size hit, currently not justified for a single dev machine.
- One more model-version + tokenizer dependency to track.
- The provider-endpoint path is the production path for users with internet
  access; local is the offline fallback.

Phase 8 (signed installers) is a natural place to revisit if local embeddings
become a competitive or compliance requirement.

### 2. Embeddings stored as JSON arrays in a new `schema_embeddings` table

Migration `0003_schema_embeddings.sql` introduces:

```sql
CREATE TABLE schema_embeddings (
    connection_id TEXT NOT NULL,
    qualified_table TEXT NOT NULL,  -- "schema.table"
    embedding TEXT NOT NULL,        -- JSON array of f32
    model TEXT NOT NULL,            -- "text-embedding-3-small" etc.
    dimensions INTEGER NOT NULL,
    embedded_at INTEGER NOT NULL,
    PRIMARY KEY (connection_id, qualified_table),
    FOREIGN KEY (connection_id) REFERENCES connection_profiles(id) ON DELETE CASCADE
);
```

JSON-encoded floats are bigger and slower than packed binary, but trivial to
debug, easy to migrate across model changes, and round-trip cleanly through
SQLCipher's text-only column type without our own framing code. For ~200
tables × 1536 floats × ~10 chars per float ≈ 3 MB of text per connection.
Acceptable.

### 3. Brute-force cosine similarity in Rust

No `sqlite-vec`, no FAISS, no specialized index. The retriever:

1. Loads all `schema_embeddings` rows for the connection (one query).
2. Computes the embedding of the question via the same provider's
   `/v1/embeddings` endpoint.
3. Cosine-sims the question vector against every stored vector.
4. Sorts and takes the top N (default 20).
5. Expands the result with the FK neighborhood from the canonical
   `SchemaModel`.

For 200 tables and 1536 dimensions, the cosine-sim loop is roughly 300 K
floating-point multiplies — sub-millisecond in Rust. We do not need a
vector index until schemas grow past ~10 K tables, at which point a real
vector store becomes interesting. Documented as a scaling rule of thumb.

### 4. Retriever activates only above the threshold

Hard-coded threshold: total tables ≥ 50. Below that, `generate_sql` passes
the full schema as Phase 4 already does. At/above, the retriever is invoked;
if no embeddings are stored, generation errors with "compute embeddings
first via Generate embeddings button." (No silent fallback to full pass-through
because for a 200-table schema the full pass-through would blow context windows.)

The threshold is hard-coded in `src-tauri/src/retrieve.rs`. Making it
user-configurable is a settings-screen polish item that can land when there's
a settings screen.

### 5. Quality measurement is deferred

The architecture-doc done-when calls for "correct SQL on a 200-table
benchmark schema with quality comparable to small-schema performance."
Genuine quality measurement requires:

- A 200-table schema we can run extraction against.
- A labeled question/SQL pair set to measure correctness.
- Re-running the loop across multiple model + retrieval-size variations.

We don't have any of those yet. Phase 5 ships the **path** end to end:
embedding storage, similarity search, FK expansion, integration with
`generate_sql`. Code-level correctness is exercised by unit tests on a
synthetic schema. The quality measurement itself is a Phase 9 concern
("first five users") — when there's a real schema and a real user.

This scope reduction is documented in `PHASE_5_LOG.md` and the roadmap
amendment.

## Tradeoffs accepted

- **No embeddings without an OpenAI-compatible config.** Anthropic-only
  setups can't trigger the retriever; they have to add a second provider
  config. Surfaced honestly in the UI; tracked as a Phase 5 follow-up to
  add Voyage AI or a local model.
- **JSON-encoded embeddings are wasteful.** Roughly 3× the size of packed
  binary. For our scale, throughput is dominated by the network round-trip,
  not the in-Rust decode. Worth revisiting only if the store gets unwieldy.
- **Brute-force cosine is O(N) per query.** Fine to ~10 K tables. We hit a
  wall well past v1 use cases.
- **Hard-coded threshold + N.** No settings UI in Phase 5. The defaults
  match the architecture doc verbatim.
- **No quality benchmark in Phase 5.** Measured deferral; the path is in
  place so a future commit can drop in a benchmark harness.

## Alternatives considered

- **Bundled local embeddings via `fastembed`.** Rejected for Phase 5 — extra
  dep, extra binary size, model-selection question. Worth revisiting if
  Phase 8 packaging needs a fully-offline mode.
- **`sqlite-vec` extension.** Real vector index inside SQLite. Adds a C
  extension to the build; load-bearing on top of SQLCipher. Justified at
  much higher table counts than v1 sees.
- **Re-embed at every generate.** Cheap on the question side (one API call
  per generate); the table-side embeddings are computed once at "embed
  schema" time. We don't re-embed tables on every question.
- **Embed each column instead of each table.** Higher fidelity at proportional
  storage cost (10–100×). The architecture doc embeds tables; we follow.
- **One embeddings-only provider config separate from chat.** Cleaner UX but
  more state. Phase 5 reuses the active LLM provider's endpoint when
  available; users with multi-provider needs can toggle the active config.

## Code locations pinned to this ADR

- `src-tauri/migrations/0003_schema_embeddings.sql`
- `src-tauri/src/store/embeddings.rs` — embeddings CRUD on the store
- `src-tauri/src/llm/embeddings.rs` — provider `/v1/embeddings` call
- `src-tauri/src/retrieve.rs` — cosine sim + FK neighborhood expansion
- `src-tauri/src/commands.rs` — `embed_schema` command, `generate_sql`
  integration
- `src/App.tsx` — "Generate embeddings" button + status
