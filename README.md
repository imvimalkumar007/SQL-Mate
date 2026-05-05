# SQL Mate: local-first natural language to SQL

A desktop application that lets data professionals ask questions of their database in plain English and get back validated read-only SQL, without ever exposing row data to an LLM or to our infrastructure.

## The one-paragraph pitch

Most AI SQL tools require either a live database connection to a hosted service or pasting schema and sample rows into a chat interface. Neither is acceptable for security-conscious teams in finance, healthcare, legal, or government. SQL Mate runs entirely on the user's machine. It extracts schema metadata locally (never row data), sends only that metadata plus the user's question to an LLM provider of the user's choice using their own API key, validates the generated SQL with `sqlglot` for read-only correctness, and hands the SQL back for the user to copy into their own SQL tool. The app does not execute the SQL — that's a deliberate security choice that turns the audit story from "we run your queries safely" into "we never run your queries at all."

## Status

Phases 1–11 shipped. The core path (connect → extract → ask → generate → validate → copy) is end-to-end working on Postgres and MySQL. Phase 10 added a Windows-only floating widget summoned by a global hotkey (per ADR 0014); Phase 11 added hotkey customization, multi-monitor safety, and start-with-Windows. Phase 9b (signed installers, notarization, distribution) is deferred — see `docs/PHASE_9B_DEFERRED.md`. Phase 12 (first five users) is product, not code.

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
├── dev.ps1                    Windows dev-shell bootstrap (CARGO_HOME, vcvars64, venv)
├── .github/workflows/build.yml  Cross-OS unsigned installer builds
├── docs/
│   ├── PROJECT_BRIEF.md       Product goals, target user, non-goals
│   ├── ARCHITECTURE.md        System design overview
│   ├── SECURITY_MODEL.md      Threat model and guarantees
│   ├── ROADMAP.md             Phased build plan
│   ├── BUGS.md                Open bugs, limitations, deferrals, manual checks
│   ├── PHASE_9B_DEFERRED.md   What's blocked on real-world signing infra
│   ├── PHASE_*_LOG.md         Per-phase build logs
│   ├── GLOSSARY.md            Shared vocabulary
│   ├── architecture/
│   │   ├── schema-extraction.md
│   │   ├── schema-store.md
│   │   ├── llm-provider.md
│   │   ├── sql-generation.md
│   │   ├── sql-validation.md
│   │   ├── query-execution.md (deprecation marker — module removed in Phase 9)
│   │   └── ui-flows.md
│   ├── design/
│   │   ├── widget-prototype.html  Visual reference for all six widget states
│   │   └── widget-design-spec.md  Authoritative widget design spec (ADR 0014)
│   └── decisions/             Architecture Decision Records (0001–0014)
├── sidecar/                   Python sqlglot validator (line-delimited JSON IPC)
├── src/                       Frontend: main window (App.tsx) + widget window (Widget.tsx)
├── widget.html                Vite entry point for the widget window
└── src-tauri/                 Backend (Rust, Tauri 2)
```

## Tech stack (as shipped)

- **Shell**: Tauri 2.x (Rust backend, WebView frontend, native installer per OS). Two windows in one app: the main administrative window and the floating widget (per ADR 0014).
- **Frontend**: TypeScript, React. Two Vite entry points (`index.html`, `widget.html`) with a shared `SqlBlock` component. Hand-rolled SQL syntax highlighter; hand-rolled inline-SVG icons for the widget (no external font CDN).
- **Backend**: Rust, with Python sidecar for `sqlglot` validation.
- **Tauri plugins**: `tauri-plugin-global-shortcut` for the widget hotkey, `tauri-plugin-autostart` for the optional start-with-Windows toggle. Tray icon uses Tauri 2's built-in `tray-icon` feature.
- **Database drivers**: `sqlx` for Postgres + MySQL schema extraction. SQLite (user database) and SQL Server are deferred per ADR 0012; the dropdown surfaces them as disabled.
- **LLM**: BYO key — `AnthropicProvider`, `OpenAIProvider`, and `OpenAICompatibleProvider` (Groq, OpenRouter, Azure, etc.) via closed-enum dispatch per ADR 0010.
- **Local storage**: SQLCipher-encrypted SQLite for schema cache, embeddings, redactions, annotations, history, provider configs, widget state, and settings. SQLCipher key in a sibling file. OS keychain deferred per [ADR 0008](docs/decisions/0008-no-keychain-in-phase-2.md).
- **PDF**: `printpdf` for the security review pack (no external font files).

Licence
Private: all rights reserved.
