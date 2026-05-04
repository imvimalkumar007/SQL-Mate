# ADR 0005: reqwest with rustls for HTTP

## Status

Accepted.

## Context

The Rust core needs an async HTTP client. Phase 1 uses it for the Anthropic Messages API call; later phases will use it for the model registry fetch (Phase 4) and provider embeddings endpoints (Phase 5). Database drivers (`sqlx`) bring their own connection logic and do not use this client; this ADR is about the HTTP path only.

The LLM call path is the most security-sensitive code in the application. `CLAUDE.md` directs us to minimize dependencies in this path. The HTTP client choice is therefore load-bearing and worth recording.

## Decision

We use `reqwest`, pinned to an exact version, with default features disabled and only `rustls-tls` and `json` enabled:

```toml
reqwest = { version = "=0.13.3", default-features = false, features = ["rustls-tls", "json"] }
```

The pin and the feature set are part of this decision. Bumping the version or changing features requires updating this ADR.

## Rationale

- **Async-native fits Tauri's tokio runtime.** `tokio` is the runtime Tauri's Rust core uses; an async HTTP client is the natural fit. A sync client would block tokio worker threads or require `spawn_blocking` plumbing for every request.
- **`rustls-tls` avoids the OpenSSL dependency on Windows.** `native-tls` on Windows uses Schannel and on Linux/macOS uses OpenSSL or SecureTransport, which complicates cross-platform builds and pulls in a C dependency. `rustls` is pure Rust, builds the same on all three target OSes, and uses webpki-roots for CA trust — predictable and self-contained.
- **Disabling default features keeps the LLM call path's dependency surface small.** Default features pull in `charset`, `http2`, `macos-system-configuration`, and others. Phase 1 needs none of these. Enabling features deliberately, one at a time, is the right default for this project's posture.
- **Exact version pin matches the project's supply-chain stance.** `CLAUDE.md` and `docs/SECURITY_MODEL.md` (T7) call for pinned dependencies and minimal auto-update. `=0.13.3` enforces this in `Cargo.toml` itself, not just `Cargo.lock`.

## Tradeoffs accepted

- **Larger dependency tree than a hand-rolled client over `hyper`.** `reqwest` brings in `hyper`, `tokio`, `rustls`, `webpki`, and their transitive deps. We accept this for the API ergonomics, well-trodden security posture, and active maintenance.
- **Manual feature management as needs grow.** When a future phase needs HTTP/2 or compression, we have to add the feature and re-review. That friction is intentional — it forces a conscious decision per added capability rather than silently expanding surface.
- **Strict version pin requires manual security updates.** When `reqwest` ships a security patch, we have to bump and re-test rather than getting it automatically. This is the explicit tradeoff of pinned-versions (ADR 0001 / `CLAUDE.md`).

## Alternatives considered

- **`ureq`.** Smaller dep tree, simpler API. Rejected because it is synchronous; using it inside Tauri's async command handlers requires `spawn_blocking` and gives up the natural fit with `tokio`.
- **Anthropic's official Rust SDK.** Would handle the Anthropic Messages API specifically, including streaming and tool use. Rejected for Phase 1 because the SDK is less mature than its Python and TypeScript counterparts, and it adds an additional dependency layer in the security-critical LLM call path. Worth re-evaluating in Phase 4 when we add the provider abstraction; for now, raw `reqwest` against the Messages API is simpler.
- **`hyper` directly.** Lower-level than `reqwest`. Rejected as too much hand-rolled code for what is, in Phase 1, one POST request. The added control isn't worth the maintenance cost given `reqwest`'s posture is already conservative.
