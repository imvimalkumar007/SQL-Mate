# ADR 0010: LLM provider abstraction shape

## Status

Accepted.

## Context

`docs/architecture/llm-provider.md` describes a `LlmProvider` trait with three
concrete implementations (Anthropic, OpenAI, OpenAI-compatible). Phase 4 turns
that into running code. Decisions to make:

1. Trait + `Box<dyn LlmProvider>` (with `async-trait`) vs. closed enum dispatch.
2. How per-provider configs are stored.
3. Where the model registry lives (CDN vs. bundled).
4. How prompt caching, structured output, and streaming map onto the abstraction.
5. How API keys are stored, given ADR 0008's keychain deferral.

## Decisions

### 1. Closed enum dispatch over trait objects

We use a closed `Provider` enum with three variants — `Anthropic`, `OpenAI`,
`OpenAICompatible` — and a single `impl Provider { async fn generate_sql ... }`
that matches and dispatches statically. No `Box<dyn LlmProvider>`, no
`async-trait` dependency.

Rationale:
- The set of concrete providers is closed-by-design. The OpenAI-compatible
  variant is the open hatch for any future REST-y endpoint (Groq, Together,
  Fireworks, Azure OpenAI, Ollama, vLLM, OpenRouter…) without needing a new
  variant.
- Static dispatch produces smaller, more inlineable code than `Box<dyn>`.
- One fewer dependency in the LLM call path. `async-trait` is small but
  per `CLAUDE.md`, that path's surface area is load-bearing.
- Rust's native `async fn` in traits works for static dispatch but requires
  workarounds for dyn trait objects. Enum dispatch sidesteps the whole
  question.

If a future phase introduces dynamically-loaded providers (plugin SDK,
arbitrary user-supplied DLLs — neither of which is a v1 goal), revisit.

### 2. Per-provider configs in the SQLCipher-encrypted local store

Migration `0002_provider_configs.sql` creates a `provider_configs` table with
one row per saved provider configuration. Columns: `id`, `name`, `kind`
(`anthropic|openai|openai_compatible`), `base_url`, `model`, `api_key`,
`created_at`. The active config is recorded in `settings` under key
`active_provider_id`.

**API keys live in the `api_key` column.** They are encrypted at rest by
SQLCipher; they are not in the OS keychain. This continues the deferral set
in ADR 0008. The Phase 4 done-when in `docs/ROADMAP.md` is amended to
"API keys are encrypted at rest in the local store" with a pointer to ADR
0008's revisit conditions.

### 3. Model registry — bundled JSON, no CDN fetch in Phase 4

A single `src-tauri/resources/model_registry.json` file is bundled with the
Rust binary via `include_str!`. It contains the providers + their canonical
models + retention notes, exactly as `docs/architecture/llm-provider.md`
describes. The file is the source of truth for the dropdown options the UI
shows when adding or editing a provider config.

CDN-hosted-with-fallback (per the architecture doc) is a Phase 8 packaging
concern. Bundling at compile time avoids a startup network call and the
cache-invalidation logic that comes with it; for Phase 4 walking-skeleton it's
the right cut.

### 4. Prompt caching, structured output, streaming

Phase 4 implements **plain text response parsing only**. Each provider sends
the same prompt structure, asks for SQL only (no JSON envelope, matching the
Phase 1+ pattern), and parses the response as a single SQL string.

- **Prompt caching (Anthropic-only):** the `capabilities()` method advertises
  it, but Phase 4 does not actually mark schema content cacheable. That lands
  when the validator + execution + provider abstraction have settled and we
  start measuring latency. Tracked as a Phase 4 follow-up.
- **Structured output:** documented in `llm-provider.md` but not implemented
  in Phase 4. Same reasoning. The current plain-SQL-with-no-explanation flow
  works end-to-end; the JSON envelope adds parsing surface and is tightly
  coupled with how we surface explanations to the UI (which we don't yet).
- **Streaming:** out of scope for Phase 4. The dev-time round-trip is fast
  enough that streaming is polish.

These deferrals are explicit so a future contributor can add them incrementally
against the existing trait shape.

### 5. Error mapping

A single `LlmError` enum is shared across providers. Each concrete
implementation maps its provider-specific HTTP status codes / error bodies
into the common shape:

```rust
pub enum LlmError {
    Auth(String),
    RateLimit,
    ModelNotFound(String),
    ContextTooLarge,
    Network(String),
    Provider(String),
}
```

The UI maps each variant to a plain-language message; we do not surface
provider-specific error fields.

## Tradeoffs accepted

- **Closed enum means a code change to add a brand-new provider kind.** The
  OpenAI-compatible variant covers most cases; if a new kind genuinely
  doesn't fit (e.g. a provider with a wildly different request shape), the
  cost is one new enum variant + one new impl + one match arm. Manageable.
- **API keys in the SQLCipher store, not the OS keychain.** Same security
  tradeoff as ADR 0008. Re-evaluated when Phase 7 begins.
- **Bundled model registry rots.** When a model is deprecated or a new one
  ships, we cut a release. Acceptable for v1; not for a long-running app
  past Phase 8.
- **No streaming.** Generated SQL appears all-at-once. The UX cost is low
  given typical generations are 0.5–3 KB and the provider returns within
  a few seconds.
- **Plain-text response parsing only.** We rely on the prompt asking for
  SQL only. Robust against most reasonable model behavior; the validator
  catches the cases where the model returns markdown fences or extra prose
  (it'll fail to parse and return a clear error).

## Alternatives considered

- **Trait + `async-trait` + `Box<dyn LlmProvider>`.** More open-ended; matches
  the architecture doc literally. Rejected for the reasons in (1) above.
- **Per-provider config in OS keychain immediately (Phase 4 includes a
  keychain re-attempt).** Rejected per ADR 0008's deferral. Not Phase 4's
  central concern.
- **One provider config "row" stored in `settings` as JSON.** Tempting for
  simplicity but loses `INSERT … ON CONFLICT` for the active selection,
  history (`created_at`), and per-row `kind` constraints. Rejected.
- **CDN-fetched model registry from day one.** Adds a network call at startup
  + offline fallback logic. Phase 4 is busy enough.
- **Streaming + structured output in Phase 4.** Worth it eventually but not
  on the critical path of "user can switch between three providers."

## Code locations pinned to this ADR

- `src-tauri/migrations/0002_provider_configs.sql` — schema for the new table.
- `src-tauri/src/llm/mod.rs` — `Provider` enum, `SqlGenerationRequest`/`Response`,
  `ProviderCapabilities`, `LlmError`.
- `src-tauri/src/llm/anthropic.rs` — refactored AnthropicProvider impl.
- `src-tauri/src/llm/openai.rs` — new OpenAI provider impl.
- `src-tauri/src/llm/openai_compatible.rs` — generic OpenAI-compatible impl.
- `src-tauri/resources/model_registry.json` — bundled registry.
- `src-tauri/src/store/providers.rs` — provider-config CRUD on the store.
- `src-tauri/src/commands.rs` — provider-management Tauri commands.
- `src/App.tsx` — provider switcher, per-provider key input, model dropdown.
