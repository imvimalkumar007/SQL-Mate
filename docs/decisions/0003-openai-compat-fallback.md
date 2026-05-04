# ADR 0003: OpenAI-compatible endpoint as universal fallback

## Status

Accepted.

## Context

We want to support "all major LLM models" without writing N integrations. Most LLM providers now expose an OpenAI-compatible API surface, including Groq, Together, Fireworks, OpenRouter, Azure OpenAI, AWS Bedrock (via LiteLLM-style proxies), Ollama for local models, vLLM for self-hosted, and many others. Anthropic and Google have native APIs that are not OpenAI-compatible at the protocol level.

## Decision

The provider abstraction has three implementations:
1. `AnthropicProvider` — first-class, native API
2. `OpenAIProvider` — first-class, native API
3. `OpenAICompatibleProvider` — generic HTTP client targeting any base URL exposing `/v1/chat/completions`

Anthropic and OpenAI get first-class implementations because they are the most common picks, and because they each support useful features (prompt caching for Anthropic, structured outputs for both) that are worth handling natively.

Everything else is reached through the generic OpenAI-compatible client.

## Rationale

- **Coverage.** This combination covers nearly every provider any user is likely to want, with three integrations instead of dozens.
- **Future-proofing.** New providers tend to ship OpenAI-compatible endpoints because the ecosystem expects them. We get those for free.
- **Local model support.** Ollama and vLLM both expose OpenAI-compatible endpoints. Self-hosted users get the same code path.
- **No dependency on third-party aggregator libraries.** Tools like LiteLLM are useful but add a dependency in the LLM call path, where we want minimal surface area for security review.

## Tradeoffs accepted

- **Provider-specific features unavailable through the generic client.** Anthropic's prompt caching, OpenAI's structured outputs, Google's safety settings, etc. We accept feature parity gaps for any provider not in the first-class set.
- **Subtle compatibility differences.** Some "OpenAI-compatible" endpoints diverge from the spec on edge cases (token counting fields, finish reasons, error shapes). The generic client handles the common path and surfaces unexpected response shapes as `ProviderError(...)` rather than crashing.
- **Capability detection complexity.** Some compatible endpoints support tool use, some don't. We default to the conservative set (no caching, no structured output enforcement) and let the model registry override per-model.

## Alternatives considered

- **One integration per provider.** Rejected; engineering cost is too high for the value, and most users will pick one of two providers anyway.
- **Use a unified library (LiteLLM, Vercel AI SDK).** Rejected for v1 because the LLM call path is security-critical and we want to minimize dependencies there. May reconsider if a unified library matures and gets a security audit we can rely on.
- **OpenAI-compatible only, no native Anthropic.** Rejected because Anthropic's prompt caching is a meaningful cost and latency win for our specific workload (same schema across many questions).
