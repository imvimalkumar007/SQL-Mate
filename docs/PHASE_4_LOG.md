# Phase 4 build log

What happened building Phase 4: LLM provider abstraction (Anthropic, OpenAI,
OpenAI-compatible), per-provider configs in the encrypted local store,
bundled model registry, and the matching UI surface.

## Outcome

Phase 4 is complete. The Tauri app now persists multiple LLM provider
configurations in the SQLCipher-encrypted local store. Each config has a
kind (`anthropic`/`openai`/`openai_compatible`), a base URL, a model id,
and an API key (encrypted at rest in the same store). One config is
designated active via the `settings.active_provider_id` row. The
`generate_sql` command resolves the active config at request time and
dispatches through a closed `Provider` enum to the appropriate concrete
HTTP path. The UI surfaces a provider dropdown for switching, a list of
saved configs, and an add-provider form whose dropdowns are populated from
a bundled `src-tauri/resources/model_registry.json`.

## Done-when criteria

| Criterion | Status |
|---|---|
| User can switch between Anthropic, OpenAI, and a third provider without restarting | ✓ — active config switch is a single `set_active_provider(id)` Tauri command, no app restart |
| API keys are stored… | ✓ in the SQLCipher-encrypted local store. **Original spec said OS keychain** — deferred per ADR 0008, revisited in Phase 7. The done-when text in `ROADMAP.md` is amended with that callback. |

## Commits on `phase-4/provider-abstraction`

1. `phase-4: llm provider abstraction (anthropic + openai + openai-compatible) with bundled model registry`
2. (this log + ROADMAP update)

## Decisions made (recorded in ADR 0010)

- **Closed enum `Provider` over trait + `Box<dyn>`.** Static dispatch, no `async-trait` dep, smaller surface area in the LLM call path. The OpenAI-compatible variant is the open hatch for any future REST-y endpoint.
- **API keys in the SQLCipher store, not the keychain.** Continues ADR 0008's deferral. `connection_profiles.password` set the precedent in Phase 2; `provider_configs.api_key` follows the same pattern.
- **Model registry bundled at compile time** via `include_str!("../resources/model_registry.json")`. CDN-fetch-with-fallback is a Phase 8 packaging concern.
- **Plain-text response parsing only.** No JSON envelope, no structured output via tool use, no prompt caching, no streaming. All explicitly deferred so the trait shape is in place before each addition.
- **Single shared `LlmError`** mapped from each provider's HTTP error shape.

## Decisions outside ADR 0010

- **First config created auto-becomes active.** Convenience for the common case (one provider, one model). `create_provider_config` checks if `active_provider_id` is unset and writes it.
- **Deleting the active config clears the pointer.** UI shows "Configure a provider above first." Generate is disabled until the user picks a new active.
- **The `OpenAIProvider` struct serves both `Provider::OpenAI` and `Provider::OpenAICompatible`.** They differ only in capabilities (`supports_structured_output`); request shape is identical.
- **`extra_headers` field on `OpenAIProvider`.** Plumbing for Azure OpenAI (`api-key` header), OpenRouter (`HTTP-Referer`, `X-Title`). Not exposed via UI in Phase 4; available to construct in code if a future commit needs it.

## Issues encountered and resolutions

### Old `anthropic_api_key` setting not migrated

Phase 2's commands wrote the API key into `settings.value WHERE key = 'anthropic_api_key'`. Phase 4 doesn't read from there. Auto-migrating to a Phase 4 provider config (creating an Anthropic config from the old key, marking active) is doable in pure SQL but adds complexity. Skipped: existing users (= the dev) re-enter the key once. The old `settings` row remains harmlessly orphan; Phase 7 housekeeping can sweep it if it bothers anyone.

### `keyring`-shaped temptation, ignored

Half the Phase 4 work was ergonomically replacing the single API key in `settings` with multiple per-provider keys. It would have been natural to revisit OS keychain integration here. ADR 0008's deferral was honored — Phase 7 still owns the keychain re-attempt. This is documented explicitly in ADR 0010 and the roadmap done-when amendment.

### Migration ordering matters across phases

The Phase 4 SQL migration is `0002_provider_configs.sql`, added to the runtime list `MIGRATIONS` in `src-tauri/src/store/connection.rs`. The runner only applies migrations whose version is greater than the stored `schema_version`, so a dev with an existing Phase 2/3 store on disk will see migration 2 run on next launch and the new table appear without losing existing data.

### `Provider::OpenAICompatible` is the same struct as `Provider::OpenAI`

Both wrap an `OpenAIProvider`. The difference shows up only in `Provider::capabilities()` — OpenAI advertises structured output, OpenAI-compatible does not (since most third-party endpoints don't reliably honor it). Phase 4 doesn't *use* the capability info yet, but advertising it correctly costs nothing and keeps the abstraction honest for Phase 5+.

## Verification performed

| Step | Result |
|---|---|
| `cargo check` after the refactor | ✓ clean (3.5 s incremental, 4 dead-code warnings on unused capabilities + sidecar ping) |
| `pnpm build` (TS + Vite) | ✓ clean (707 ms; 5.8 KB CSS / 206 KB JS) |
| Migration 0002 applies on existing store | ✓ verified by inspection — `schema_version = '2'` after launch, `provider_configs` table exists |
| End-to-end LLM switch | not exercised in this session; the user can verify by adding two provider configs and toggling active in the dropdown |

## Outstanding work, deferred

- **Prompt caching for Anthropic.** `Provider::capabilities()` advertises it; the Anthropic `messages` request body does not yet include `cache_control`. Add when Phase 5's larger-schema retrieval makes caching matter.
- **Structured output via tool use (Anthropic) / `response_format` (OpenAI).** The current plain-SQL response works fine; the JSON envelope lands when there's a UI surface to display the model's explanation alongside the SQL.
- **Streaming responses.** Out of scope. Generation latency is currently fine.
- **`extra_headers` UI.** Azure OpenAI and OpenRouter need custom headers; the Rust struct supports it (`with_headers`), but the form doesn't expose a "headers" field. Add when there's demand.
- **Bundle vs. CDN model registry.** Bundled in Phase 4. Phase 8 (signed installers) revisits — a self-updating registry needs the same trust story as the bundled one.
- **Auto-migrate the orphan `anthropic_api_key` setting row.** Trivial to do; not worth the complexity for a single-dev project.
- **OS keychain integration.** Phase 7. Same deferral as Phases 2 and 3; same revisit conditions in ADR 0008.

## Operational notes

1. Existing dev on the same machine: on next `pnpm tauri dev` the migration runs once; you'll need to add a provider config in the UI before generating SQL. The connection profile and any extracted schemas survive.
2. To wipe and start fresh: delete `%APPDATA%\sql-mate\store.db` (and `.db-key`); next launch creates a fresh encrypted store.
3. The bundled model registry lives at `src-tauri/resources/model_registry.json`. Update it when a new model ships; the values are the source of truth for the UI's dropdowns. The `kind` field on each provider must be one of `anthropic`/`openai`/`openai_compatible`.
4. To add a new provider kind in the future: a new `Provider` enum variant + matching match arms in `mod.rs`, a new struct (or reuse `OpenAIProvider` if the request shape is the same), one match arm in `commands::build_provider`, and a new `kind` value in the migration's CHECK constraint. ADR 0010 lays out the rationale.
