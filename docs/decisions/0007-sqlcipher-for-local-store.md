# ADR 0007: SQLCipher (via rusqlite + bundled OpenSSL) for the local store

## Status

Accepted.

## Context

`docs/architecture/schema-store.md` mandates that the local store at `<app data dir>/sql-mate/store.db` is encrypted with SQLCipher, with the encryption key derived from a value held in the OS keychain. SQLCipher is the de facto standard for SQLite-at-rest encryption; it's a fork of SQLite with a page-level encryption layer that needs an OpenSSL-compatible cryptographic provider.

This creates a tension with ADR 0005, which chose `rustls` specifically to avoid an OpenSSL dependency in the LLM HTTP path. We need to be explicit about how we resolve that.

## Decision

We use `rusqlite` with the `bundled-sqlcipher-vendored-openssl` feature for the local store:

```toml
rusqlite = { version = "=0.39.0", features = ["bundled-sqlcipher-vendored-openssl"] }
```

This bundles SQLite, SQLCipher's modifications, and the OpenSSL source code at compile time. There is no runtime system dependency on OpenSSL — the whole stack is statically linked into our binary.

The OpenSSL link applies **only to the local-store path**. The LLM HTTP path (ADR 0005) and the Postgres connection (ADR 0006) continue to use `rustls`. ADR 0005 stands.

## Rationale

- **Matches the architecture doc.** The schema-store doc has been the source of truth on the encryption posture since Phase 0; choosing anything else here would require re-litigating the security model.
- **Vendored OpenSSL means no system OpenSSL install.** OpenSSL source is bundled and compiled by `openssl-src` at build time. The build needs a C compiler (we have one from VS Build Tools as of Phase 1) but does not need a system OpenSSL package on the developer's or end-user's machine.
- **`rusqlite` is sync, but that's fine for the local store.** Tauri command handlers are async; we wrap calls into `rusqlite` with `tokio::task::spawn_blocking` to keep them off the async runtime. The local store is small and queries are short — the overhead of `spawn_blocking` is negligible.
- **Two SQLite stacks in the binary is acceptable for now.** When Phase 6 adds SQLite as a *user dialect* (extracted from the user's database), `sqlx-sqlite` will join the binary alongside `rusqlite`. That's a real duplication; we'll decide then whether to fold both stacks together or accept it. Documented as Phase 6 follow-up.

## Tradeoffs accepted

- **First cold build adds 3–10 minutes.** Compiling OpenSSL from C source the first time is slow. Subsequent builds are cached.
- **Binary size grows by ~10 MB.** Statically linked OpenSSL + SQLCipher.
- **Sync API requires `spawn_blocking` plumbing.** Every call into the store happens inside an async Tauri command, so each one wraps a `spawn_blocking`. We accept the boilerplate; the alternative (an async SQLite + SQLCipher crate) is not currently mature enough to depend on.
- **An OpenSSL now exists in the binary that wasn't there in Phase 1.** We accept this exception to ADR 0005's rationale because the OpenSSL is local-only — it never sees the network. The LLM HTTP path and the Postgres TLS path are still pure-Rust.

## Alternatives considered

- **`sqlx-sqlite` with custom SQLCipher patches.** No maintained patch set exists for current `sqlx`; we'd be forking. Rejected.
- **Plain SQLite with no encryption, deferred to a later phase.** Rejected because the schema-store doc explicitly specifies SQLCipher and a "we used plaintext for a phase" period weakens the security review story. Also, swapping the storage engine later would require a one-shot migration that adds risk.
- **File-level encryption with a crate like `cocoon`.** Rejected because it doesn't support live SQLite operations; we'd have to decrypt to a temp file, which is fragile and creates plaintext on disk.
- **`libsql` / `turso` with built-in encryption.** Promising project but its Rust binding is younger than `rusqlite`; not yet a reasonable swap for this role. Worth re-evaluating once it stabilizes.
