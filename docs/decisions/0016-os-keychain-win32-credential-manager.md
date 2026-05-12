# ADR 0016: OS keychain for the SQLCipher key via Win32 Credential Manager

## Status

Accepted. Supersedes the deferral in ADR 0008.

## Context

ADR 0008 deferred OS keychain integration because `keyring` 3.6.3 (and 4.0.0)
silently failed to persist credentials on Windows 10.0.26200. As a workaround,
the 32-byte SQLCipher key was written to a plain file at
`<app data dir>/sql-mate/.db-key`, sitting next to the encrypted store.

Phase 12's security hardening work (preceding this ADR) tightened the file's
ACL via `icacls` and added `cipher_memory_security`, but the fundamental
weakness remained: anyone with read access to the user's app data directory
could decrypt the store by reading both files.

Windows Credential Manager stores entries encrypted with DPAPI (Data
Protection API), keyed to the current Windows user's login credential. Reading
a Credential Manager entry requires the user's credential — a meaningfully
higher bar than file ACL access, which can be bypassed by admins, backup
restore, or process injection.

### Why not `keyring` 4.x

The silent failure in ADR 0008 was traced to the crate's Windows backend, not
to an API contract issue. Later `keyring` versions restructure the API but do
not guarantee the underlying platform backend is fixed. Debugging a third-party
crate's silent failure is high-effort with unclear payoff.

### Why not `tauri-plugin-stronghold`

Stronghold is an app-level encrypted vault, not an OS keychain. It introduces
its own password / key-derivation ceremony and is harder to reason about from a
security-review perspective than a direct Win32 call. Worth reconsidering for
cross-platform secret storage in a future phase.

### Why direct Win32 API

`windows-sys` is already a transitive dependency of Tauri on Windows. Calling
`CredWriteW` / `CredReadW` directly gives us:

- No silent failures — we get explicit Win32 error codes.
- No additional native build dependencies.
- Behaviour that is auditable in a one-screen Rust module.
- Exact control over the credential target name, type, and persistence flag.

## Decision

**Store the 32-byte SQLCipher key in Windows Credential Manager** under the
target name `sql-mate/db-key`, with `CRED_TYPE_GENERIC` and
`CRED_PERSIST_LOCAL_MACHINE`. Use `windows-sys` (already in the dep tree) for
the Win32 calls. Retain the `.db-key` file approach with `chmod 0600` for
non-Windows platforms (macOS / Linux) until a native keychain story lands for
those targets.

**Migration is transparent:** on first launch after the upgrade, if a legacy
`.db-key` file is found, its contents are moved into Credential Manager and the
file is deleted. If Credential Manager write fails (rare, e.g. domain policy
restriction), the file is retained as a fallback and a warning is printed to
stderr; the user is told to resolve Credential Manager access.

## Key storage decision matrix

| Platform | Storage | Encryption | Migration |
|---|---|---|---|
| Windows | `CredWriteW` → Credential Manager | DPAPI per user | Automatic from `.db-key` file |
| macOS | `.db-key` file, `chmod 0600` | None beyond file ACL | — |
| Linux | `.db-key` file, `chmod 0600` | None beyond file ACL | — |

macOS Keychain and Linux Secret Service / kwallet are named revisit targets for
a future phase.

## Rationale

- **Raises the bar on the primary Windows attack surface.** Reading from
  Credential Manager requires the Windows user's login credential (or
  SeSecurityPrivilege). Reading a file requires only filesystem access, which
  admins, shadow copies, and OneDrive backups all provide.
- **Transparent to existing users.** The migration runs once on the first
  launch after the upgrade. No user action required.
- **Audit-friendly.** The entire keychain integration is ~120 lines in
  `src-tauri/src/store/connection.rs` under a `#[cfg(target_os = "windows")]`
  block. A security reviewer can read it in one sitting.
- **Fixes the backup-exposure risk from ADR 0008.** `CRED_PERSIST_LOCAL_MACHINE`
  means the entry is not roamed and does not appear in user-profile backups
  (OneDrive, Roaming Profile). A backup restored to another machine cannot
  decrypt the store.

## Tradeoffs accepted

- **Windows-only improvement.** macOS and Linux continue with the file-based
  approach. This is acceptable because the app is Windows-primary (ADR 0014)
  and the file approach is no worse than before on those platforms.
- **No recovery from lost Credential Manager entry.** If the entry is deleted
  from Credential Manager, the database is permanently unreadable (same as the
  old `.db-key` file being deleted). We do not provide a recovery mechanism by
  design — recoverable encryption is not encryption. Users are advised to keep
  regular exports.
- **Domain policy restriction edge case.** In some corporate environments,
  Credential Manager writes by applications may be blocked by group policy. In
  that case the migration warning is shown and the `.db-key` file is kept. We
  log the error clearly; the user can ask IT to allow Credential Manager writes
  for the app.

## Alternatives considered

- **`keyring` 4.x crate.** Deferred: the crate's Windows backend behaviour is
  still untested on this machine; debugging it is medium effort.
- **`tauri-plugin-stronghold`.** Deferred: app-level vault, not OS keychain.
  Different threat model; harder to audit. Revisit if cross-platform coverage
  is needed.
- **Direct `windows-sys` calls for macOS Keychain too.** Out of scope for this
  ADR; macOS uses `Security.framework` (a different API surface). File-with-0600
  is retained as a placeholder.

## Code changes

- `src-tauri/Cargo.toml` — `windows-sys` added as a Windows-only target
  dependency with `Win32_Foundation` and `Win32_Security_Credentials` features.
- `src-tauri/src/store/connection.rs` — `keychain` module (Windows-only) with
  `save`, `load`, `delete`; `load_or_create_db_key` rewritten with
  keychain-first logic and file migration; `rotate_db_key` writes to keychain
  on Windows.

## Revisit conditions

- macOS Keychain integration (Security.framework / `keyring` crate) if macOS
  support becomes a priority.
- Linux Secret Service / kwallet if Linux packaging is pursued.
- `tauri-plugin-stronghold` if cross-platform unified secret storage is
  preferred over per-OS native APIs.
