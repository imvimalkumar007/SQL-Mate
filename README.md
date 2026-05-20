# SQL Mate: local-first natural language to SQL

A desktop application that lets data professionals ask questions of their database in plain English and get back validated read-only SQL — without ever exposing row data to an LLM or to our infrastructure.

## The one-paragraph pitch

Most AI SQL tools require either a live database connection to a hosted service or pasting schema and sample rows into a chat interface. Neither is acceptable for security-conscious teams in finance, healthcare, legal, or government. SQL Mate runs entirely on the user's machine. It extracts schema metadata locally (never row data), sends only that metadata plus the user's question to an LLM provider of the user's choice using their own API key, validates the generated SQL with `sqlglot` for read-only correctness, and hands the SQL back for the user to copy into their own SQL tool. The app does not execute the SQL — that's a deliberate security choice that turns the audit story from "we run your queries safely" into "we never run your queries at all."

## Status — v0.2.0

Phases 1–12 shipped. The core path (connect → extract → ask → generate → validate → copy) is end-to-end working on Postgres and MySQL.

**What's in v0.2.0 (Phase 12):**
- Floating widget is now the primary mode of use — toggle chips for Session Context and Suggestions are always visible in the widget body, and a history panel is one click away in the header
- Opt-in session context lets you ask natural follow-up questions without re-stating the filter; opt-in follow-up suggestions offers 3 clickable next-question chips after each generation
- One-click update launcher (`update.bat`) — double-click to rebuild and reinstall
- Windows Credential Manager stores the SQLCipher key (upgraded from plain file, per ADR 0016)
- Design polish pass: unified radius token scale, raised contrast on dim text and validated badge, focus rings on all interactive elements, 28×28 px touch targets in the widget
- Release build OOM fix: `codegen-units = 1` prevents simultaneous rlib mmaps exhausting the Windows paging file
- Version bumped to 0.2.0; app icon replaced with neon `;)` logo

Phase 9b (signed installers, notarization, distribution channels) is deferred — see `docs/PHASE_9B_DEFERRED.md`.

## Where to start

If you are a contributor or an AI assistant picking this up:

1. Read `docs/PROJECT_BRIEF.md` for the product goals, target user, and non-goals.
2. Read `docs/ARCHITECTURE.md` for the system design.
3. Read `docs/SECURITY_MODEL.md` for the threat model and guarantees we make.
4. Read `CLAUDE.md` for working norms when using Claude Code on this project.
5. Read the per-area docs under `docs/architecture/` for module-specific detail.

## Repository layout

```
sql-mate/
├── README.md                  This file
├── CLAUDE.md                  Instructions for Claude Code sessions
├── update.bat                 One-click rebuild + reinstall launcher (Windows)
├── update.ps1                 PowerShell script invoked by update.bat
├── dev.ps1                    Windows dev-shell bootstrap (CARGO_HOME, vcvars64, venv)
├── .github/workflows/build.yml  Cross-OS unsigned installer builds
├── docs/
│   ├── PROJECT_BRIEF.md       Product goals, target user, non-goals
│   ├── ARCHITECTURE.md        System design overview
│   ├── SECURITY_MODEL.md      Threat model and guarantees
│   ├── ROADMAP.md             Phased build plan (Phases 0–12 documented)
│   ├── BUGS.md                Open bugs, limitations, deferrals, manual checks
│   ├── GLOSSARY.md            Shared vocabulary
│   ├── PHASE_9B_DEFERRED.md   What's blocked on real-world signing infra
│   ├── PHASE_*_LOG.md         Per-phase build logs
│   ├── architecture/
│   │   ├── schema-extraction.md
│   │   ├── schema-store.md
│   │   ├── llm-provider.md
│   │   ├── sql-generation.md   (includes two-column formatting spec)
│   │   ├── sql-validation.md
│   │   ├── query-execution.md  (deprecation marker — module removed in Phase 9)
│   │   └── ui-flows.md
│   ├── design/
│   │   ├── widget-prototype.html  Visual reference for all seven widget states
│   │   └── widget-design-spec.md  Authoritative widget design spec
│   └── decisions/             Architecture Decision Records (0001–0017)
├── sidecar/                   Python sqlglot validator (line-delimited JSON IPC)
├── src/                       Frontend: main window (App.tsx) + widget window (Widget.tsx)
│   ├── widget-icons.tsx        Inline SVG icons for the widget (no CDN)
│   └── widget.css              Widget-specific design tokens and styles
├── widget.html                Vite entry point for the widget window
└── src-tauri/                 Backend (Rust, Tauri 2)
```

## Tech stack (as shipped)

- **Shell**: Tauri 2.x (Rust backend, WebView frontend, native installer per OS). Two windows in one app: the main administrative window and the floating widget (per ADR 0014).
- **Frontend**: TypeScript, React. Two Vite entry points (`index.html`, `widget.html`) with a shared `SqlBlock` component. Hand-rolled SQL syntax highlighter; hand-rolled inline-SVG icons for the widget (no external font CDN).
- **Backend**: Rust, with a Python sidecar for `sqlglot` validation.
- **Tauri plugins**: `tauri-plugin-global-shortcut` for the widget hotkey, `tauri-plugin-autostart` for the optional start-with-Windows toggle. Tray icon uses Tauri 2's built-in `tray-icon` feature.
- **Database drivers**: `sqlx` for Postgres + MySQL schema extraction. SQLite (user database) and SQL Server are deferred per ADR 0012; the dropdown surfaces them as disabled.
- **LLM**: BYO key — `AnthropicProvider`, `OpenAIProvider`, and `OpenAICompatibleProvider` (Groq, OpenRouter, Azure, etc.) via closed-enum dispatch per ADR 0010.
- **Local storage**: SQLCipher-encrypted SQLite for schema cache, embeddings, redactions, annotations, history, provider configs, widget state, and settings. SQLCipher key stored in Windows Credential Manager (DPAPI, per ADR 0016). OS keychain for other platforms deferred per ADR 0008.
- **PDF**: `printpdf` for the security review pack (no external font files).

## Security guarantees (summary)

The full threat model is in `docs/SECURITY_MODEL.md`. In short:

| What we guarantee | How |
|---|---|
| No row data leaves the machine | Schema extraction reads metadata queries only; `information_schema` and catalog views, never `SELECT * FROM table` |
| LLM calls go direct from your machine to your provider | No proxy, no server in the middle, your API key |
| Generated SQL is read-only | AST-validated by `sqlglot` before display; mutations, DDL, and `SELECT INTO` are rejected |
| Secrets encrypted at rest | SQLCipher-encrypted local SQLite; key in Windows Credential Manager (DPAPI) |
| No telemetry without opt-in | Default off; the toggle is a placeholder — no payload is sent in this build |

## Rebuilding and installing

Double-click `update.bat` in the project root. It will:
1. Prepend Strawberry Perl to `PATH` (required for the OpenSSL build step)
2. Run `pnpm tauri build` (5–10 minutes)
3. Close any running SQL Mate process
4. Launch the NSIS installer automatically

The installer filename is discovered automatically — no manual version number required.

## Licence

Private: all rights reserved.
