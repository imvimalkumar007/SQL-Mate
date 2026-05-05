# Phase 5 build log

What happened building Phase 5: embedding-based schema retrieval for
larger schemas, exposed via a new `embed_schema` Tauri command, the
`retrieve` module's cosine-sim + FK-neighborhood expansion, and a status
panel in the UI.

## Outcome

Phase 5 ships the **code path** end to end:

- Provider-endpoint embeddings (OpenAI `/v1/embeddings`, also covers any
  OpenAI-compatible provider that exposes the same shape).
- A new `schema_embeddings` table (migration `0003`) stores per-table
  vectors as JSON arrays alongside their model name, dimensions, and a
  timestamp.
- The `retrieve` module computes cosine similarity in pure Rust, picks the
  top-20, and expands via the FK neighborhood — both directions (parents
  and children).
- `generate_sql` activates retrieval when the canonical `SchemaModel` has
  ≥ 50 tables; below that threshold, it passes the full schema through
  unchanged.
- The UI's Schema card now shows an embeddings-status row with
  Generate / Re-generate / Clear buttons and a textual indicator of when
  retrieval is active.
- Three unit tests in `retrieve.rs` cover FK expansion (forward, reverse,
  and the schema-filter behavior).

The architecture-doc done-when calls for "correct SQL on a 200-table
benchmark schema." We don't have that benchmark here — see "Outstanding
work, deferred" below for what that costs and where it should land.

## Done-when criteria

| Criterion | Status |
|---|---|
| Embedding-based table retrieval works for schemas > 50 tables | ✓ code path end to end; unit tests verify FK expansion |
| Embeddings via configured provider's endpoint | ✓ via `llm/embeddings.rs::embed_openai`, OpenAI shape |
| Local model fallback | deferred; ADR 0011 §1 lays out the rationale |
| 200-table benchmark with comparable quality | **deferred** — no 200-table schema available; quality measurement needs labeled question/SQL pairs we don't have. Tracked as a Phase 9 concern. |

## Commits on `phase-5/schema-retrieval`

1. `phase-5: embedding-based schema retrieval with cosine sim and fk neighborhood expansion`
2. (this log + ROADMAP update)

## Decisions made (recorded in ADR 0011)

- **Provider-endpoint only, no bundled local model.** ~30 MB binary cost
  not justified for a single-dev project. Phase 8 packaging revisits.
- **Anthropic configs cannot embed.** Anthropic has no embeddings API.
  Both `embed_schema` and `generate_sql` (when retrieval activates) return
  a clear error pointing the user at OpenAI/compat. Voyage AI integration
  could solve this but is out of scope.
- **JSON-encoded embeddings.** ~3× bigger than packed binary; ~3 MB per
  200-table connection. Trivially debuggable. Real cost is dominated by
  the network round-trip, not the in-Rust decode.
- **Brute-force cosine in Rust.** No `sqlite-vec`, no FAISS. O(N) per
  query is sub-millisecond for hundreds of tables. We hit a wall well past
  v1 use cases.
- **Hard-coded threshold (50) and N (20).** Match the architecture doc
  verbatim. No settings UI.
- **One-hop FK expansion both directions.** Parent (referenced) and child
  (referencing) tables are added; we do not recurse. Avoids pulling the
  whole schema for a densely-connected core table.

## Decisions outside the ADR

- **Same provider for table and question embeddings.** When `generate_sql`
  triggers retrieval, it uses the *exact* model recorded on the stored
  vectors to embed the question. If the user re-embeds with a different
  model, both sides update consistently.
- **`embed_schema` reuses the active provider.** No separate "embedding
  provider" config. Adding that complicates the UX for the 90% case (one
  provider). If the user runs Anthropic for chat and OpenAI for embeddings,
  they switch active config briefly to embed, then switch back.
- **Default embedding model: `text-embedding-3-small`.** 1536 dimensions,
  OpenAI's recommended default. Configurable per request in the Tauri
  command (`embedding_model` parameter); UI doesn't surface this.
- **Mismatched-dimension vectors are silently skipped during cosine.** If
  the user re-embeds with a new model that changes dimensions, the old
  vectors don't break the cosine pass — they just get filtered. The UI
  surfaces the model + count so the user can tell.
- **Embedding text is `"schema.table_name. Columns: col: type, ..."`.**
  Compact and informative. Phase 5 doesn't include FKs in the embedded
  text (the FK information surfaces via post-cosine expansion, not the
  vector content itself).

## Issues encountered and resolutions

### sqlx pulls a lot of crates; nothing changed in Phase 5

Phase 5 added zero net dependencies — `serde_json` for JSON-encoding the
vectors and `reqwest` for the embeddings HTTP call were both already in
the tree. The cargo-check after wiring everything was 2.6 seconds
incremental. Nice.

### `dimensions` column is "dead code" but kept

The `StoredEmbedding.dimensions` field generates a `dead_code` warning
because the cosine path looks at `embedding.len()` directly. The column
is kept anyway for forward compatibility — when we add a "your stored
embeddings are stale (dimensions mismatch)" UI affordance, the column
saves us a pass over the JSON. `#[allow(dead_code)]` or removing it
entirely are equally reasonable; chose the warning over removing the
column because the migration is forward-only.

### No good way to test retrieval end-to-end without a 200-table DB

The unit tests exercise the FK expansion logic on a 5-table synthetic
schema. They cannot exercise:

- Embedding round-trip against a real provider (mock would test the wire
  but not the model).
- Cosine ranking quality (depends on the model).
- The combination of retrieval + chat generation against a labeled
  benchmark.

The architecture-doc done-when calls for that benchmark. We do not have
the schema, the question set, or the model-version pinning to do it
faithfully, and synthesizing any of those would produce a worse signal
than waiting until Phase 9 has a real user. This is documented in ADR
0011 §5 as a deliberate scope reduction.

## Verification performed

| Step | Result |
|---|---|
| `cargo check` after wiring | ✓ clean (2.58 s incremental, 5 dead-code warnings, all benign) |
| `cargo test --lib retrieve::` | ✓ 3 / 3 pass (FK expansion forward, reverse, filter_schema) |
| `pnpm build` (TS + Vite) | ✓ clean (691 ms; 5.8 KB CSS / 207 KB JS) |
| Migration 0003 applies on existing store | ✓ verified by inspection — `schema_version = '3'` after launch, `schema_embeddings` table exists |
| End-to-end embed → retrieve flow | not exercised in this session against a real DB; the seed schema is 4 tables (below threshold) so retrieval doesn't activate. Unit tests cover the logic correctness. |

## Outstanding work, deferred

- **Local embedding model.** `fastembed` Rust crate + `bge-small-en` would
  fit in ~30 MB. Worth doing when (a) Phase 8 packaging is on the table
  and offline is a competitive feature, or (b) a real user without
  consistent network needs it.
- **`sqlite-vec` extension.** Brute-force cosine is fine to ~10 K tables.
  Past that, a proper vector index becomes interesting. Not v1.
- **200-table benchmark with quality measurement.** Phase 9 (first five
  users) is the right moment — by then we'll have real schemas + real
  questions to measure against.
- **Voyage AI / Cohere / other embedding providers.** Currently OpenAI-shape
  only. Add when an Anthropic-only user asks.
- **Settings UI for `RETRIEVAL_THRESHOLD` and `RETRIEVAL_TOP_N`.** Hard-coded
  in `retrieve.rs` per ADR 0011. Polish item; lands when there's a
  general settings screen.
- **Embedding text richness.** Current text is `name + columns + types`.
  Could include FK relationships, sample annotations, or column comments
  if extracted. Worth measuring on a benchmark before adding complexity.

## Operational notes

1. **Re-running `pnpm tauri dev`:** migration 0003 applies on next launch
   for an existing store; schema-cache and connections survive.
2. **Anthropic-only setups can't trigger retrieval.** If you have only an
   Anthropic provider configured and your schema is ≥ 50 tables, generate
   will error with a clear pointer to add an OpenAI-or-compat provider.
3. **The seed test schema has 4 tables**, which is below the threshold;
   the retrieval code path won't activate against it. Use it to exercise
   the pre-retrieval flow; the unit tests cover post-threshold logic.
4. **To force-test the retrieval activation locally:** lower
   `RETRIEVAL_THRESHOLD` in `src-tauri/src/retrieve.rs` to e.g. 3, rebuild,
   and the seed schema's 4 tables will trip the gate. (Don't commit that
   change.)
