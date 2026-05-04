# Phase 1 build log

A record of what happened while building the walking skeleton, including decisions made off the kickoff doc, problems hit, and how the developer environment ended up. Captured so future-me (and Phase 2) can pick up cleanly.

## Outcome

Phase 1 is complete and verified end-to-end on Windows. The Tauri 2.x app builds, launches, accepts an Anthropic API key in a session-only field, sends a hardcoded schema and question to the Anthropic Messages API using `claude-opus-4-7`, and displays the returned SQL.

## Done-when criteria

| Criterion | Status |
|---|---|
| `pnpm tauri dev` launches the Tauri app | ✓ on Windows; macOS and Linux deferred |
| Settings field for an Anthropic API key (session-only) | ✓ with the required amber banner |
| "Generate SQL" button takes a hardcoded stub schema and a hardcoded question, calls Anthropic, displays the returned SQL | ✓ |
| ADR 0005 exists at `docs/decisions/0005-reqwest-for-http.md` | ✓ |
| All commits land on `phase-1/scaffold` with `phase-1: ` prefixes | ✓ |

## Commits on `phase-1/scaffold` (oldest first)

1. `phase-1: scaffold tauri react-ts app` — `pnpm create tauri-app` output, moved into the project root
2. `phase-1: drop unused tauri-plugin-opener and rename window to SQL Mate`
3. `phase-1: add reqwest http client and adr 0005`
4. `phase-1: implement anthropic call and generate_sql command`
5. `phase-1: walking-skeleton ui with api-key field and generate button`
6. `phase-1: use rustls feature for reqwest 0.13 and pin lockfile`
7. `phase-1: rename project Schema SQL -> SQL Mate in README`

(Two more land alongside this log: the architecture-doc rename and the build log itself.)

## Decisions made (not warranting full ADRs)

- **`tauri-plugin-opener` removed from the scaffold's defaults.** The `pnpm create tauri-app` template adds it; Phase 1 doesn't open URLs, so it was deleted from `Cargo.toml`, `package.json`, and `capabilities/default.json` to keep the dependency surface minimal.
- **Hardcoded model: `claude-opus-4-7`.** Per `docs/architecture/llm-provider.md`'s recommended default. Will be selectable via the model registry in Phase 4.
- **Window dimensions 900×700.** Slightly larger than the scaffold's 800×600, to give the API-key field, banner, and output box room without scrolling.
- **Phase 1 LLM prompt simplified.** `docs/architecture/sql-generation.md` describes a JSON envelope (`{sql, explanation, confidence?}`) returned via tool use or as a JSON code block. Phase 1 asks the model for plain SQL only and displays the raw text. Rationale: structured-output handling and parsing are Phase 3 (validation) work; for the walking skeleton, "displays the returned SQL" is satisfied by the simpler shape. Revisit when the validator and provider abstraction land.
- **Cargo.lock committed.** Standard practice for binary projects; aligns with the supply-chain stance in `CLAUDE.md` and `docs/SECURITY_MODEL.md` (T7).

## Issues encountered and resolutions

These will bite again on macOS/Linux verification or on a fresh Windows machine. Worth recording.

### Project layout was doubly nested

The handoff bundle landed at `e:\Learning\SQL Mate\SQL Mate\` (outer `SQL Mate` containing the inner project root). All work happens in the inner folder. Tooling commands use `git -C "SQL Mate"` and `pnpm -C "SQL Mate"` to operate without changing CWD.

### Handoff docs arrived as chat attachments with mojibake

`SETUP.md`, `PHASE_1_KICKOFF.md`, `START_HERE.md`, and `.gitignore` were transmitted as chat document attachments rather than placed on disk, and the em-dashes / box-drawing characters in them had been mangled (looked like UTF-8 bytes interpreted as cp1252). Rewritten on disk with normalized characters before the first commit.

### Missing prerequisites

At session start, only Node 24 was on the developer's machine. Installed during the session: pnpm (via `npm install -g pnpm`), Rust 1.95.0 stable-x86_64-pc-windows-msvc (silent rustup install to `~/.cargo`), VS Build Tools 2022 17.14 (custom path on D:). `gitleaks` and `gh` CLI not installed — both optional per SETUP step 1.

### reqwest 0.13.3 renamed the `rustls-tls` feature to `rustls`

`PHASE_1_KICKOFF.md` specified `rustls-tls`, which was the reqwest 0.12 feature name. The Cargo resolver flagged it on first `cargo check`. Updated `Cargo.toml` and ADR 0005 to use `rustls`. Mechanically equivalent — `rustls` in 0.13 enables `aws-lc-rs` as the cryptographic provider and bundles `webpki-roots` for trust.

### VS Build Tools install: out of disk on C:

C: had only 1.9 GB free out of 200 GB. Default install needs ~5–7 GB on C: even with `--includeRecommended` removed, because the Windows SDK lives at `C:\Program Files (x86)\Windows Kits\10\` and is **not** relocatable via `--installPath`. First install attempt died with `0x80070070` (`ERROR_DISK_FULL`).

### VS Build Tools install: invalid `--cachePath` flag

To redirect the package cache off C: during install, first attempt used `--cachePath D:\VSCache`. The bootstrapper rejected the args with exit code 87 (`ERROR_INVALID_PARAMETER`). The correct flag (per Microsoft Learn) is `--path cache=<path>`, not `--cachePath`. Fixed; install proceeded.

### VS Build Tools install: SDK silently skipped

Even with the right command, `Microsoft.VisualStudio.Component.Windows10SDK.20348` was passed but the SDK never installed. The bootstrapper exited 0; the SDK files were absent; `kernel32.lib` could not be found anywhere on disk. Cause unknown — the installer log mentions the component ID once but reports no plan or install for it. Worked around via a separate `modify` operation adding `Microsoft.VisualStudio.Component.Windows11SDK.26100`, which installed the SDK to `C:\Program Files (x86)\Windows Kits\10\Lib\10.0.26100.0\`.

### Cargo + MSVC requires a developer environment per shell

After the install was complete and `vswhere.exe` correctly detected VS at `D:\VSBuildTools`, `cargo check` first failed with "linker `link.exe` not found" (PATH didn't include MSVC bin), then with "cannot open input file 'kernel32.lib'" (LIB env didn't include the SDK lib path). Resolution: source `D:\VSBuildTools\VC\Auxiliary\Build\vcvars64.bat` in the shell before running `cargo` or `pnpm tauri dev`. **This must be done in any new shell.** Phase 2 should consider a `dev.ps1` wrapper or a `[env]` block in `.cargo/config.toml`, though the latter would hard-code MSVC and SDK version paths which would rot on update.

## Verification performed

| Step | Result |
|---|---|
| `pnpm install` | clean (9.7 s) |
| `pnpm build` (`tsc && vite build`) | clean — TypeScript types fine, ~195 KB JS bundle |
| `cargo check` (after vcvars sourced) | clean (2 m 9 s) |
| `pnpm tauri dev` first cold build | finished in 2 m 46 s; window opened titled "SQL Mate" |
| End-to-end with a real Anthropic key | clicked Generate SQL, got back a plausible `SELECT` over `public.customers`/`public.orders` |

## Outstanding setup work, deferred

- **Branch protection on `main`** (SETUP step 7) — needs the GitHub UI; cannot automate without `gh` CLI. Required before the Phase 1 PR can be merged.
- **Signed commits** — git signing was never configured (`CLAUDE.md` prohibits the agent from updating git config). All `phase-0:` and `phase-1:` commits are unsigned. To merge with "Require signed commits" branch protection, the developer must run the three `git config` commands from SETUP step 3 and then re-sign history with `git rebase --exec 'git commit --amend --no-edit -S' <upstream>` over both `main` and `phase-1/scaffold`.
- **gitleaks scan** — not run; tool not installed. Files in scope contain no secrets, but a clean scan would be reassuring before merge.
- **Cross-OS verification** — macOS and Linux walking-skeleton runs are part of the original Phase 1 spec but require those machines. Deferred.

## Operational notes for whoever continues

1. **Always source MSVC env before native builds.** In a fresh PowerShell:

   ```powershell
   $vcvars = "D:\VSBuildTools\VC\Auxiliary\Build\vcvars64.bat"
   cmd /c "`"$vcvars`" && set" | ForEach-Object {
       if ($_ -match '^([^=]+)=(.*)$') {
           Set-Item -Path "env:$($Matches[1])" -Value $Matches[2]
       }
   }
   $env:Path = "$env:USERPROFILE\.cargo\bin;$env:Path"
   ```

   After this, `cargo` and `pnpm tauri dev` will find `link.exe` and the Windows SDK.

2. **The dev server is interactive.** `pnpm tauri dev` keeps running until you close the SQL Mate window. To stop from a separate shell: close the window, or `Get-Process -Name "sql-mate","node" | Stop-Process`.

3. **Project root is `e:\Learning\SQL Mate\SQL Mate\`** (the inner folder). Every command in this repo's tooling assumes that.

4. **C: drive footprint of this setup.** ~1.67 GB at `C:\Program Files (x86)\Windows Kits\10\` (necessary), ~0.10 GB at `C:\Program Files (x86)\Microsoft Visual Studio\` (the VS Installer, kept for future updates/modifications). VS Build Tools binaries themselves live at `D:\VSBuildTools\` (~1.7 GB).
