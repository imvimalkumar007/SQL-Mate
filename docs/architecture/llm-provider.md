# LLM provider

Abstraction over LLM providers. Lets the user pick Anthropic, OpenAI, Google, or any OpenAI-compatible endpoint, and swap providers without touching anything outside this module.

## Interface

```rust
#[async_trait]
trait LlmProvider: Send + Sync {
    async fn generate_sql(
        &self,
        request: SqlGenerationRequest,
    ) -> Result<SqlGenerationResponse, LlmError>;

    fn supports_prompt_caching(&self) -> bool;
    fn supports_structured_output(&self) -> bool;
    fn capabilities(&self) -> ProviderCapabilities;
}

struct SqlGenerationRequest {
    system_prompt: String,
    schema_slice: SchemaSlice,
    user_question: String,
    model: String,
    max_tokens: u32,
}

struct SqlGenerationResponse {
    sql: String,
    explanation: String,
    confidence: Option<f32>,
    tokens_used: TokenUsage,
}
```

## Implementations

### `AnthropicProvider`

Uses Anthropic's Messages API directly. Supports prompt caching via the `cache_control` block on the schema content. Supports structured output via tool use (we define a single tool `respond_with_sql` with a JSON schema for `sql`, `explanation`, `confidence`).

Default model: `claude-opus-4-7`. Other supported models surfaced via the model registry.

### `OpenAIProvider`

Uses OpenAI's Chat Completions API. Supports structured output via response_format with JSON schema. No prompt caching API available as of the cutoff for this doc; treat as unsupported until the registry says otherwise.

### `OpenAICompatibleProvider`

Generic HTTP client that targets any base URL exposing `/v1/chat/completions`. Capabilities default to the conservative set (no caching, no structured output enforced; we use JSON-mode prompting and validate the response). Used for Groq, Together, Fireworks, OpenRouter, Azure OpenAI, Ollama, vLLM, and any future provider with a compatible API.

## Provider configuration

A provider is configured with:

- A friendly name shown in the UI
- A base URL (defaulted, editable)
- A keychain reference for the API key
- The selected model identifier
- Optional headers (used for Azure deployments and OpenRouter routing)

The active configuration is stored in `settings`. Multiple configurations can be saved; one is active.

## Model registry

A static JSON file fetched from a CDN at app launch and cached locally. Falls back to a bundled copy if offline. Shape:

```json
{
  "version": 1,
  "updated_at": "2026-...",
  "providers": [
    {
      "id": "anthropic",
      "name": "Anthropic",
      "base_url": "https://api.anthropic.com",
      "models": [
        {
          "id": "claude-opus-4-7",
          "name": "Claude Opus 4.7",
          "context_window": 200000,
          "supports_caching": true,
          "supports_structured_output": true,
          "recommended_for": "default"
        }
      ],
      "retention_note": "Zero retention available on Enterprise tier; otherwise 30 days. See https://anthropic.com/legal."
    }
  ]
}
```

The registry never includes API keys or anything sensitive. Its only purpose is to populate dropdowns and display retention notes.

## Prompt structure

The exact prompt is documented in `docs/architecture/sql-generation.md`. From the provider's perspective, the system prompt and user message are built upstream and passed in as opaque strings. The provider only handles transport, model-specific options, and response parsing.

## Caching

For providers that support it, mark the schema content as cacheable. Schemas don't change between questions in a session, so cache hits should be near-100% after the first question. This is a meaningful cost and latency win.

## Error handling

Errors are mapped to a `LlmError` enum:

- `AuthError` — bad API key
- `RateLimitError` — provider rate-limited; surface retry-after if available
- `ModelNotFound` — model identifier rejected
- `ContextTooLarge` — schema slice plus question exceeded model's context window; suggest narrowing schema
- `NetworkError` — transport failure
- `ProviderError(String)` — anything else, with message for the user

All errors are presented to the user with a plain-language explanation and, where applicable, a suggested fix.

## Testing

Each provider has a recorded-fixture test that asserts the request payload contains only schema metadata fields. This is the load-bearing test for our security claim. It runs on every PR.

A mock provider (`MockProvider`) is used for UI development and integration tests; it returns deterministic SQL based on the question keyword.
