# Phase 2 build log

A record of what happened building Phase 2: live Postgres schema extraction
and the encrypted local store. Captured for the next session, for security
reviews of the Phase 2 deviation, and so the toolchain quirks we hit don't
catch the next person off-guard.

## Outcome

Phase 2 is complete and verified end-to-end on Windows. The Tauri app boots,
opens an encrypted local store, lets the user save an Anthropic API key and a
Postgres connection profile, tests the connection, extracts the schema by
running the documented `information_schema` query, persists the canonical
`SchemaModel`, and generates SQL against that persisted schema with the
Anthropic Messages API.

The Phase 2 done-when's "OS keychain" piece is **not** as originally specified
— see ADR 0008. Secrets are SQLCipher-encrypted at rest, not in the OS
keychain. Phase 7 should revisit.

## Done-when criteria

| Criterion | Status |
|---|---|
| Connect to a real Postgres database | ✓ local Postgres 17.9 on `localhost:54320` |
| See the extracted schema in the UI | ✓ tree view with PK, NOT NULL, FK badges |
| Have it persisted across app restarts | ✓ via `<app data dir>/sql-mate/store.db` (SQLCipher-encrypted) |
| End-to-end question-to-SQL against the real schema | ✓ generated `SELECT` against `customers`/`orders` joined seed data |

The original spec also wanted "secrets in OS keychain"; the Phase 2 reality is
SQLCipher-encrypted local storage. Honest summary in `SECURITY_MODEL.md` and
ADR 0008.

## Commits on `phase-2/extraction-and-store` (oldest first)

1. `phase-2: add postgres+sqlcipher deps, adrs 0006-0007, and dev.ps1 wrapper`
2. `phase-2: add encrypted local store with sqlcipher + key from os keychain`
3. `phase-2: postgres schema extractor`
4. `phase-2: tauri commands for connections, extraction, and api key in keychain`
5. `phase-2: ui rewrite for connection profiles, schema viewer, and keychain api key`
6. `phase-2: drop keychain usage and store secrets in sqlcipher-encrypted store`
7. (this log + ADR 0008 + doc revisions)

## Decisions made (not warranting full ADRs, but documented for future-me)

- **Per-repo `CARGO_HOME`.** `.cargo-home/` lives inside the repo (gitignored).
  Set in `dev.ps1`. C: drive on the dev machine ran out of space several times
  during Phase 2; redirecting cargo's registry cache off C: was the fix.
- **`CARGO_BUILD_JOBS=1`** in `dev.ps1`. The `windows-rs` crate (Win32 bindings)
  needed several GB of peak RAM to compile and OOM'd rustc when other crates
  compiled in parallel. Single-job builds are slower but fit the available
  memory headroom.
- **Strawberry Perl portable on E:.** Required for `openssl-src` (vendored
  OpenSSL bundled by `rusqlite-sqlcipher`). Git for Windows ships a minimal
  Perl that lacks core modules `openssl-src` needs. `dev.ps1` auto-detects
  Strawberry Perl at `E:\strawberry-perl-portable\perl\bin`.
- **VS Installer dir on PATH inside `dev.ps1`.** `vcvars64.bat` shells out to
  `vswhere.exe` by bare name; that directory isn't in the inherited PATH of
  fresh shells under this Tauri tool, so `dev.ps1` prepends it.
- **`time` crate over `chrono`.** Lighter dep, modern API, suffices for Unix
  timestamps in store columns. No interaction with sqlx's date types because
  the Phase 2 metadata query returns text/integer only.
- **`uuid v4` for connection-profile IDs.** Standard.
- **Phase 2 LLM prompt unchanged from Phase 1.** Plain-SQL response, no JSON
  envelope yet. The full envelope per `docs/architecture/sql-generation.md`
  comes with Phase 3 validation.
- **Single-row `Mutex<Connection>` for the store.** No connection pool; each
  Tauri command briefly acquires the mutex and runs sync `rusqlite` calls.
  Adequate for a single-user desktop. `tokio::task::spawn_blocking` not used
  yet — Phase 3 may revisit if validator/sqlglot calls become bottlenecks.
- **`time::OffsetDateTime::now_utc().unix_timestamp()` for all `created_at`
  / `extracted_at` / `last_used_at` columns.** Stored as INTEGER; readable.

## Issues encountered and resolutions

These will bite again on macOS/Linux verification, on a fresh Windows machine,
or in CI. Worth recording.

### C: drive disk pressure (recurring)

The dev machine started with ~1.9 GB free on C: out of 200 GB. Multiple Phase 2
operations needed C: temp / cache space and ran into `ERROR_DISK_FULL`:

- Cargo's default `~/.cargo/registry` lives on C:. Fix: `CARGO_HOME` redirected
  to `<repo>/.cargo-home` (on E:). Saved ~700 MB on C: and gave the registry
  room to grow.
- VS Build Tools default install lands on C: (~5 GB). Fix: `--path install=D:`
  + `--path cache=D:` redirected the binaries and the package cache. Windows
  SDK still goes to `C:\Program Files (x86)\Windows Kits\10\` — that path is
  not relocatable.
- rustc OOM during the `windows-rs` compile, exacerbated by the page file
  not being able to grow with C: nearly full. Fix: `CARGO_BUILD_JOBS=1` so only
  one rustc runs at a time.

### VS Build Tools install: `--cachePath` is not a valid flag

First attempt at relocating the package cache used `--cachePath D:\VSCache` and
the bootstrapper rejected with exit code 87 (`ERROR_INVALID_PARAMETER`) in
~4 seconds. The correct syntax (per Microsoft Learn) is `--path cache=<dir>`,
not `--cachePath`. Fixed; install proceeded.

### VS Build Tools install: SDK silently skipped

Even with the right command, `Microsoft.VisualStudio.Component.Windows10SDK.20348`
was passed but the SDK never installed. Bootstrapper exited 0; SDK files were
absent; `kernel32.lib` could not be found anywhere on disk. Worked around by a
subsequent `modify` operation adding `Microsoft.VisualStudio.Component.Windows11SDK.26100`,
which did install. Cause unknown; logs reference the originally-requested
component once but never plan or install it.

### `dev.ps1` ErrorActionPreference leaked when dot-sourced

First version of `dev.ps1` set `$ErrorActionPreference = "Stop"` at the top.
When dot-sourced (`. .\dev.ps1`), that setting leaked into the calling shell.
Subsequent `cargo check` runs died on the first stderr line cargo emits
("Compiling foo") because PowerShell wraps native stderr as ErrorRecords and
treats them as terminating errors under that pref. Symptom: cargo never
actually compiled anything; the output file showed only `dev.ps1`'s setup
prints. Fix: save and restore the caller's `$ErrorActionPreference`.

### `2>&1` on cargo lost the build output

Adjacent to the ErrorActionPreference issue. `cargo check ... 2>&1` redirects
native stderr through PowerShell's pipeline, which wraps lines as ErrorRecord
objects. Even after fixing the pref leak, this redirection is unfriendly and
not needed (Tauri's tool captures both streams). Fix: drop `2>&1`.

### Stale cargo lock

After killing a cargo run mid-flight, leftover `.cargo-lock` files in the
target dir blocked the next cargo from starting. Symptom: "Blocking waiting
for file lock on build directory." Fix: remove stale `.cargo-lock` files;
`dev.ps1` now does not, but `kill stale procs + delete target/.cargo-lock` is
the recipe in PHASE_2_LOG.md.

### `openssl-src` requires Perl with core modules

Building OpenSSL from C source uses Perl scripts (`./Configure` and friends).
First attempted with Git for Windows' bundled `perl.exe` at
`C:\Program Files\Git\usr\bin\perl.exe` — failed because Git's Perl is
stripped down and lacks `Locale::Maketext::Simple` (and others) that OpenSSL's
config scripts require. Fix: install Strawberry Perl portable to
`E:\strawberry-perl-portable\` and prepend its `perl\bin` to PATH ahead of
Git's Perl. `dev.ps1` does this auto-detection.

### `keyring` 3.6.3 silently fails on this Windows build

`Entry::set_password` returned `Ok(())` but credentials never appeared in
Windows Credential Manager. Verified by `cmdkey /list` showing zero entries
matching `sql-mate`/`db-key`/`anthropic`/`connection-password`. Bypass via
upgrade to `keyring` 4.0.0 was rejected because 4.0 is a major API restructure
(private `Error`, restructured `Entry`, libsql/turso storage backend). Decision
recorded in ADR 0008: drop keyring in Phase 2; store secrets in the
SQLCipher-encrypted local store; revisit in Phase 7.

### Windows SDK component IDs are version-sensitive

The bootstrapper accepted `Microsoft.VisualStudio.Component.Windows10SDK.20348`
in the args but didn't install it. Switched to `Windows11SDK.26100` via a
`modify` operation and that worked. Recorded so the next install attempt picks
the working component ID.

### Local Postgres for testing

Phase 2 needs a real Postgres. Options on a fresh dev machine:
- **Neon free tier** — ~30 sec sign-up, browser OAuth required.
- **Local Docker** — Docker Desktop install needed.
- **EDB binaries** — what we used. Downloaded
  `https://sbp.enterprisedb.com/getfile.jsp?fileid=1260148` (PostgreSQL 17.9
  Windows x64 binaries, ~316 MB). Extracted to `E:\postgres\pgsql\`.
  `initdb -A trust` for localhost-only, `pg_ctl ... -o "-p 54320" start` to
  avoid clobbering the conventional 5432 port. Seed schema in `E:\postgres-seed.sql`
  (4 tables with FKs, 15 rows total).

### Window opened minimized / off-screen

Final dev-server launch had `sql-mate.exe` running with a valid `MainWindowHandle`
but no visible window. Used Win32 `ShowWindow(SW_RESTORE)` +
`SetWindowPos(100, 100, 900, 700)` + `SetForegroundWindow` to bring it to the
foreground. Cause unknown — possibly Tauri restoring a previous window state
that was offscreen.

## Verification performed

| Step | Result |
|---|---|
| `cargo check` after each module add | clean (1.9 s incremental → 8 m 20 s cold) |
| `pnpm build` (TS + Vite) | clean, 763 ms, 5.2 KB CSS / 201 KB JS |
| `cargo build --debug` (full link with sql-mate.exe produced) | clean, 11 m 23 s cold |
| `pnpm tauri dev` window opens, schema migration runs | ✓ first launch creates `<app data dir>/sql-mate/.db-key` (32 bytes) and `store.db` (~52 KB) |
| Save API key | ✓ persisted in `settings.value` for key `anthropic_api_key` |
| Add connection profile | ✓ row in `connection_profiles` |
| Test connection | ✓ green "Connection OK." |
| Extract schema | ✓ tree shows 4 tables with PK/FK badges |
| Generate SQL | ✓ Anthropic returned a `SELECT` against `customers`/`orders` |
| Persistence across restart | not yet exercised end-to-end (close window → re-launch) |

## Outstanding work, deferred

- **OS keychain integration.** Per ADR 0008, revisit when Phase 7 begins. Likely
  candidates: `keyring` 4.0 migration with the `keyring-core` API, direct
  `windows-sys` CredWriteW calls, or `tauri-plugin-stronghold`.
- **Branch protection on `main`.** Still not configured (see PHASE_1_LOG.md).
- **Signed commits.** All Phase 2 commits are unsigned. Same backfill recipe
  as Phase 1: configure SSH signing per SETUP step 3, then
  `git rebase --exec 'git commit --amend --no-edit -S' main`.
- **gitleaks scan.** Not run.
- **Cross-OS verification.** Phase 2 only tested on Windows. macOS and Linux
  paths haven't been exercised.
- **Read-only DB role enforcement.** `extract_schema` issues `SET
  default_transaction_read_only = on` after connecting (defense in depth on
  top of the user-configured role). Real read-only-role enforcement is the
  user's database-side configuration; the seed for testing uses the unrestricted
  `postgres` superuser, which is fine for Phase 2 verification but should be
  swapped for a `sqlmate_ro` role per the security model.
- **Schema persistence-across-restart end-to-end test.** Backend code persists;
  store.db survives. UI behavior on relaunch (does the saved API key auto-load,
  does the connection list rehydrate) was not exercised end-to-end this
  session.

## Operational notes for whoever continues

1. **Source `dev.ps1` in every fresh shell.** It sets `CARGO_HOME`,
   `CARGO_BUILD_JOBS=1`, prepends Strawberry Perl + cargo bin + the VS
   Installer dir to PATH, and sources `vcvars64.bat`. Without it, cargo can't
   find the linker, the SDK headers/libs, or Perl.
2. **Local Postgres test harness.** The local Postgres is at
   `E:\postgres\pgsql\` with data dir `E:\postgres-data\`. Start with
   `& "E:\postgres\pgsql\bin\pg_ctl.exe" -D E:\postgres-data -l E:\postgres-data\logfile.log -o "-p 54320" start`.
   Stop with `pg_ctl ... stop`. Connection details: `localhost:54320`,
   db `sqlmate_test`, user `postgres`, password `postgres` (trust auth).
3. **App state lives at `%APPDATA%\sql-mate\`** on Windows. Two files:
   `.db-key` (32 bytes — wipe to reset everything) and `store.db` (SQLCipher
   encrypted; readable only with the matching `.db-key`).
4. **C: drive is the bottleneck.** Aggressive cleanup of `%TEMP%` happens
   intermittently. If a cargo build dies with `os error 112`, the page file
   ran out of room — close apps to free RAM, then retry.
5. **Window may open offscreen.** If the SQL Mate window doesn't show after
   `pnpm tauri dev` reports `Running target\debug\sql-mate.exe`, use the Win32
   `ShowWindow(SW_RESTORE) + SetForegroundWindow` recipe in PowerShell to
   force it onscreen.
