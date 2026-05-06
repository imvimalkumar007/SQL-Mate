# Architecture Decision Records

Decisions are numbered sequentially and live in this directory.
Each record captures the context, decision, rationale, tradeoffs,
and alternatives considered at the time it was written.

| # | Title | Status |
|---|-------|--------|
| [0001](0001-tauri-over-electron.md) | Tauri over Electron for the desktop shell | Accepted |
| [0002](0002-byo-api-key.md) | Bring-your-own LLM API key | Accepted |
| [0003](0003-openai-compat-fallback.md) | OpenAI-compatible endpoint as universal fallback | Accepted |
| [0004](0004-sqlglot-for-validation.md) | sqlglot via Python sidecar for SQL validation | Accepted |
| [0005](0005-reqwest-for-http.md) | reqwest with rustls for HTTP | Accepted |
| [0006](0006-sqlx-for-postgres.md) | sqlx for the Postgres driver | Accepted |
| [0007](0007-sqlcipher-for-local-store.md) | SQLCipher for the local store | Accepted |
| [0008](0008-no-keychain-in-phase-2.md) | Defer OS keychain; secrets live in the SQLCipher store | Accepted |
| [0009](0009-python-sidecar-lifecycle.md) | Python sidecar lifecycle and IPC protocol | Accepted |
| [0010](0010-llm-provider-abstraction.md) | LLM provider abstraction shape | Accepted |
| [0011](0011-embedding-based-schema-retrieval.md) | Embedding-based schema retrieval for large schemas | Accepted |
| [0012](0012-dialect-rollout-strategy.md) | Dialect rollout strategy for Phase 6 | Accepted |
| [0013](0013-user-facing-model-switching.md) | User-facing model and provider switching | Accepted |
| [0014](0014-floating-widget-windows.md) | Floating widget as primary UI on Windows | Accepted |
| [0015](0015-multi-database-picker.md) | Multi-database picker in the widget | Accepted |
