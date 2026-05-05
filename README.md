# SQL Mate — local-first natural language to SQL

A desktop application that lets data professionals ask questions of their database in plain English and get back SQL queries — without ever exposing row data to an LLM or to our infrastructure.

## The one-paragraph pitch

Most AI SQL tools require either a live database connection to a hosted service or pasting schema and sample rows into a chat interface. Neither is acceptable for security-conscious teams in finance, healthcare, legal, or government. SQL Mate runs entirely on the user's machine. It extracts schema metadata locally (never row data), sends only that metadata plus the user's question to an LLM provider of the user's choice using their own API key, and validates and runs the generated SQL locally against a read-only database connection. We are never in the data path.

## Status

Pre-alpha. Architecture and documentation phase. No code yet beyond skeleton.

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
├── docs/
│   ├── PROJECT_BRIEF.md       Product goals, target user, non-goals
│   ├── ARCHITECTURE.md        System design overview
│   ├── SECURITY_MODEL.md      Threat model and guarantees
│   ├── ROADMAP.md             Phased build plan
│   ├── GLOSSARY.md            Shared vocabulary
│   ├── architecture/
│   │   ├── schema-extraction.md
│   │   ├── schema-store.md
│   │   ├── llm-provider.md
│   │   ├── sql-generation.md
│   │   ├── sql-validation.md
│   │   ├── query-execution.md
│   │   └── ui-flows.md
│   └── decisions/             Architecture Decision Records (ADRs)
│       ├── 0001-tauri-over-electron.md
│       ├── 0002-byo-api-key.md
│       ├── 0003-openai-compat-fallback.md
│       └── 0004-sqlglot-for-validation.md
├── src/                       Frontend (TypeScript + React)
└── src-tauri/                 Backend (Rust)
```

## Tech stack (current plan)

- **Shell**: Tauri 2.x (Rust backend, web frontend, ~10MB binaries, native keychain access)
- **Frontend**: TypeScript, React, Tailwind CSS
- **Backend**: Rust, with Python sidecar for `sqlglot` validation
- **Database drivers**: `sqlx` (Rust) for Postgres, MySQL, SQLite, MSSQL
- **LLM**: BYO key — Anthropic SDK + OpenAI SDK as first-class, OpenAI-compatible HTTP for everything else
- **Local storage**: SQLCipher-encrypted SQLite for schema cache, query history, and secrets. OS keychain integration deferred to Phase 7 — see [ADR 0008](docs/decisions/0008-no-keychain-in-phase-2.md).

Licence
Private — all rights reserved.
