# ADR 0008: Defer OS keychain integration; secrets live in the SQLCipher store

## Status

Accepted, with explicit revisit in Phase 7.

## Context

`docs/architecture/schema-store.md`, `docs/SECURITY_MODEL.md` (T4), and
`CLAUDE.md` non-negotiable #5 all called for secrets — the SQLCipher key,
database connection passwords, and the LLM API key — to live in the OS keychain
(Windows Credential Manager / macOS Keychain / Linux Secret Service). The
rationale: keychain entries are isolated per-user and per-machine and are not
encrypted by the same key as the application's local store.

During Phase 2 implementation we observed that the `keyring` crate version
3.6.3, with its `windows-native` backend, **silently fails to persist
credentials** on the development machine (Windows 10.0.26200 / Insider build).
`Entry::set_password()` returns `Ok(())`, but no entry appears in Windows
Credential Manager (verified via `cmdkey /list`). The bug manifests for both
the SQLCipher key (`(sql-mate, db-key)`) and the per-connection database
password.

We attempted a bump to `keyring` 4.0.0. That release is a substantial API
restructure: `keyring::Error` becomes private, `Entry`'s methods change shape,
and the dep tree pulls in `keyring-core` plus an embedded libsql/turso storage
backend. The migration cost is significant, and the underlying Windows backend
issue may persist regardless of API version.

We need Phase 2 to land. Given the keychain integration is unreliable on the
target development machine and the migration to a working keychain is a
medium-sized investigation, we accept a temporary deferral.

## Decision

**Phase 2 stores secrets inside the SQLCipher-encrypted local store, not in the
OS keychain.** Specifically:

- The SQLCipher key is loaded from a file at `<app data dir>/sql-mate/.db-key`
  (32 random bytes generated on first launch). When the file is missing, a new
  key is generated; an existing store encrypted with the previous key becomes
  unreadable, by design.
- Database connection passwords are stored in a `password` column on the
  `connection_profiles` table. The whole SQLite file is encrypted by SQLCipher,
  so passwords are not in plaintext on disk.
- The Anthropic API key is stored in the existing `settings` table under key
  `anthropic_api_key`.

The `keyring` dependency is removed from `Cargo.toml`.

## Rationale

- **Phase 2 done-when needs to be reachable.** The architecture doc commits us
  to "schema persisted across app restarts" and a working live-extraction loop.
  Without working keychain, the choice was either: skip Phase 2 verification
  entirely, or store secrets somewhere on disk. SQLCipher-encrypted storage is
  the strictly-better choice over plaintext or session-only.
- **Security posture is reduced but not zero.** The store file is encrypted at
  rest with a 32-byte CSPRNG key. An attacker with file-system access can read
  the SQLCipher key file alongside the encrypted store and decrypt — that's the
  regression vs. a real keychain, which would require additional OS-level
  privilege escalation. Mitigation: same threat (compromised local machine)
  that `docs/SECURITY_MODEL.md` already lists under "What we do not guarantee."
- **The deferral is auditable.** This ADR, an updated ADR 0007, an amendment to
  CLAUDE.md non-negotiable #5, and revisions to `SECURITY_MODEL.md` and
  `schema-store.md` all explicitly document the current state. Anyone running a
  security review can find the deviation in five minutes.

## Tradeoffs accepted

- **Local-machine compromise leaks more.** A real keychain raises the bar on
  reading the SQLCipher key (DPAPI-encrypted under the user's credential).
  Our file-based key sits next to the encrypted store with normal user-mode
  ACLs. An attacker with read access to the user's app data directory has
  everything they need to decrypt.
- **Backup risk.** The `.db-key` file ends up in user-profile backups (OneDrive,
  Time Machine, etc.) alongside the encrypted store. Restoring a backup on
  another machine "just works" — convenient but defeats the per-machine
  isolation a keychain would provide.
- **Documentation drift.** `CLAUDE.md` non-negotiable #5, `SECURITY_MODEL.md`
  threat T4, and `schema-store.md` originally promised keychain integration.
  We update those docs honestly rather than letting the gap persist silently.

## Alternatives considered

- **Stay on `keyring` 3.6.3 and debug the silent-failure.** Likely a Windows
  Credential Manager interaction we don't yet understand. Could take hours of
  work plus a bug report upstream. Phase 2 does not block on this.
- **Migrate to `keyring` 4.0.0.** Major API break (private `Error`, restructured
  `Entry`, embedded libsql in the tree). Migration cost is non-trivial and the
  underlying Windows behavior may not be fixed. Worth re-evaluating in Phase 7.
- **Use `tauri-plugin-stronghold`.** Tauri's recommended secret-vault plugin.
  Adds plugin infrastructure and a different security model (app-encrypted
  vault, not OS keychain). Worth a closer look in Phase 7.
- **Direct Windows API via `windows-sys` (CredWriteW).** Bypass `keyring` and
  call the Win32 API directly. Reproducible and debuggable, but turns the
  cross-platform concern (macOS, Linux) into custom code per OS. Save for
  Phase 7 when we have proper time.
- **Session-only secrets, like Phase 1.** User re-pastes API key + DB password
  every launch. Worse UX; we already had this in Phase 1. Phase 2's whole
  point is persistence.

## Revisit conditions

This ADR is reopened when **any** of the following are true:

- Phase 7 (annotations + redaction) work begins. The redaction code path also
  touches secrets-handling, so it's the natural place to revisit keychain
  integration with concrete time budgeted.
- A Phase 2 user reports the threat model is unacceptable for their use case.
- Tauri ships a stable `tauri-plugin-keychain` (or equivalent) with first-class
  Windows support.

## Code changes pinned to this ADR

- `src-tauri/Cargo.toml` — `keyring` dependency removed.
- `src-tauri/migrations/0001_initial_schema.sql` — `connection_profiles`'s
  `keychain_ref` column renamed to `password`.
- `src-tauri/src/store/connection.rs` — `load_or_create_db_key` reads from
  `.db-key` file instead of keychain.
- `src-tauri/src/commands.rs` — all `keyring::Entry` calls removed; secrets
  flow through the store and the `settings` table.
