# Project brief

## What we are building

A desktop application that lets data professionals ask questions of their database in natural language and get back a SQL query they can review and execute, with strong guarantees that no row data and no live database connection ever leave the user's machine.

## Why now

Frontier LLMs are good enough at SQL generation that the bottleneck is no longer model quality — it is access to the schema. Every major database tool is shipping AI SQL features, but nearly all of them require either a hosted database connection, sending sample rows to the model, or proxying through a vendor server. None of those are acceptable for security-conscious teams in regulated industries. There is a real, underserved buyer for whom security posture is the deciding factor.

## Target user (v1)

A data engineer or analytics engineer at a regulated mid-market company (financial services, healthcare, legal, or government). Their work environment has these properties:

- Production database access is read-only and gated by their security team.
- They cannot paste schema or queries into ChatGPT or any consumer AI tool.
- They use a SQL IDE (DataGrip, DBeaver, pgAdmin) for exploratory analysis.
- They are technically capable of running a SQL query and uploading a file, or installing a desktop app.
- Their organization may already have approved enterprise access to Anthropic, OpenAI, or a similar provider, often via Bedrock or Azure.

We are not designing v1 for non-technical business users. We are not designing v1 for individual hobbyists. Both may end up using the tool, but design tradeoffs go to the regulated data engineer.

## What success looks like in v1

- The user can extract schema from their own database and load it into the app in under five minutes, without writing any SQL themselves.
- The user can ask a typical analytical question ("what were Q3 sales by region, joined with customer tier") and get a correct SQL query back roughly 80% of the time on a schema with up to 100 tables.
- The user can defend the tool to their security team using a single page of plain-language documentation. The security team can verify the data flow claims without trusting us.
- The user runs the generated query against their database from inside the app and sees results. The results never leave their machine.

## Non-goals

These are explicitly not part of v1. They may come later, but mentioning them is enough to defer them.

- **Hosted SaaS mode.** No web app, no shared backend, no team workspaces.
- **Writing queries.** No `INSERT`, `UPDATE`, `DELETE`, schema migrations, or DDL. Read-only only.
- **Shared schema annotations or query history across users.** Single-user, local-only.
- **Auto-fixing or auto-running queries.** The user always reviews the SQL before execution. Always.
- **Fine-tuned models or vector databases for schema retrieval beyond a simple embedding cache.** Schema retrieval matters, but we start with the simplest thing that works for ~100 tables and only get fancier if needed.
- **Mobile.** Desktop only.
- **Free tier with our own LLM key.** BYO key from day one.

## Non-goals we may revisit

- **Team mode** with shared schema annotations. This would require a sync layer that does not weaken the security story (likely local-first with end-to-end encrypted sync). Worth designing toward, not building yet.
- **Self-hosted LLM support.** Already covered by the OpenAI-compatible endpoint flow, but no first-class UI for it in v1.
- **PDF and SVG schema ingestion.** Earlier design conversations included these. Cut from v1 because users with database access will use the live extractor; the file-upload path is a niche fallback.

## Distribution

Single signed installer per platform: `.exe` (Windows), `.dmg` (macOS, signed and notarized), `.AppImage` and `.deb` (Linux). No app stores in v1.

## Pricing (working assumption, not committed)

Free for individual use with BYO key. Paid tier for teams adds shared signed query library, audit log export, and security review documentation pack — none of which require us to be in the data path. To be revisited after first 10 paying customers.
