# Roadmap

Milestones, in order. Each phase has a "done when" criterion. Do not start the next phase until the previous one's done-when is met.

## Phase 0 — Foundation (done)

Documentation and architecture only. No production code.

**Done when:** This `docs/` directory is reviewed and signed off. ADRs 0001–0004 are accepted.

## Phase 1 — Walking skeleton (done)

Tauri app launches. Hardcoded schema is sent to a hardcoded Anthropic API call with a hardcoded question. Result is parsed and shown.

**Goal:** Prove the end-to-end shape works on all three target OSes (macOS, Windows, Linux).

**Done when:** A developer on each target OS can run `pnpm tauri dev`, paste an API key into a settings field, click a button, and see a SQL query generated from a stub schema. — Verified end-to-end on Windows. macOS and Linux verification deferred until those machines are available; see `PHASE_1_LOG.md` for the build log.

## Phase 2 — Live schema extraction (Postgres only) (done)

Implement the Rust schema extractor for Postgres. User pastes connection details, app connects with read-only credentials, runs the metadata queries documented in `docs/architecture/schema-extraction.md`, normalizes to the canonical schema model, persists to the local SQLite store.

**Done when:** A user can connect to a real Postgres database, see the extracted schema in the UI, and have it persisted across app restarts. End-to-end question-to-SQL works against this real schema. — Verified end-to-end on Windows against a local Postgres 17.9 instance with a 4-table seed schema. OS keychain integration deferred per ADR 0008; see PHASE_2_LOG.md for the build log.

## Phase 3 — Validation and execution (done; execution later removed in Phase 9)

Wire up the Python sidecar with `sqlglot`. Generated SQL is validated for read-only before display. Add the "run query" button that executes against the user's database in a read-only transaction with a timeout and row cap.

**Done when:** The full loop works for Postgres: connect, extract, ask, see SQL, validate, run, see results. All without any row data touching the LLM call path. Validator rejects all non-`SELECT` statements in tests. — Verified end-to-end on Windows: Python 3.14 sidecar with `sqlglot==30.7.0`, layer-1 Rust pre-parse, layer-2 sqlglot AST walk, executor running in a `default_transaction_read_only` enforced transaction with 1000-row cap and 30 s timeout. See `PHASE_3_LOG.md`.

**Phase 9 update:** the run-query path was removed entirely during Phase 9's UX overhaul. The validator still ships and still gates whether SQL is shown to the user, but the executor is gone — see `docs/architecture/query-execution.md` for the archaeology marker and `SECURITY_MODEL.md` T2 for the rationale. This phase's "done" status remains correct as a historical record of when the loop was first end-to-end working.

## Phase 4 — Provider abstraction (done)

Refactor the LLM client into the provider interface documented in `docs/architecture/llm-provider.md`. First-class support for Anthropic and OpenAI. OpenAI-compatible fallback for any base URL the user provides. Model registry loaded from a static JSON file.

**Done when:** A user can switch between Anthropic, OpenAI, and a third provider (e.g., Groq via OpenAI-compatible) without restarting the app. API keys are stored in the SQLCipher-encrypted local store. (The original done-when called for OS keychain storage; deferred to Phase 7 per ADR 0008. Closed enum dispatch instead of `Box<dyn LlmProvider>` per ADR 0010.) See `PHASE_4_LOG.md` for the build log.

## Phase 5 — Schema retrieval for larger databases (done — code path)

Add embedding-based table retrieval for schemas with more than ~50 tables. Embeddings are computed locally if a local model is available, or via the configured LLM provider's embedding endpoint otherwise (still BYO key, still no row data).

**Done when:** The app generates correct SQL on a 200-table benchmark schema with quality comparable to small-schema performance. — Phase 5 ships the **path** end to end: provider-endpoint embeddings (OpenAI / OpenAI-compatible), JSON-stored vectors, brute-force cosine, top-20 + FK neighborhood expansion, integration with `generate_sql`. The 200-table quality benchmark is genuinely deferred to Phase 9 (first five users) because we don't have a 200-table schema or a labeled question set to measure against. Local embedding model is a follow-up. See ADR 0011 and `PHASE_5_LOG.md`.

## Phase 6 — Other dialects (done — Postgres + MySQL; SQLite + SQL Server deferred)

Add MySQL, SQL Server, SQLite. Each requires its own extractor and dialect-aware validator settings. UI does not change meaningfully.

**Done when:** All four dialects pass the Phase 3 done-when criterion. — Phase 6 ships **MySQL** end-to-end (extractor, dispatcher, dialect dropdown). SQLite is deferred until the `sqlx-sqlite` × `rusqlite + bundled-sqlcipher` linker conflict is investigated; SQL Server is deferred until there's a real SQL Server to test against and a willingness to onboard `tiberius`. See ADR 0012 and `PHASE_6_LOG.md` for the named revisit conditions.

## Phase 7 — Model and provider switching (current)

User-facing picker in the main query UI to switch providers and models per session, with a cost-tier indicator pulled from the model registry. Defaults bias toward the cheapest model so first-time users don't get a surprise bill from Opus 4.7. Implements ADR 0013.

**Done when:** A user with two configured providers can swap between them in the main query screen, and within Anthropic can swap between Opus / Sonnet / Haiku — without leaving the query flow. The generated-SQL view shows which model produced it. The model registry's `cost_tier` field drives the indicator shown next to each model.

## Phase 8 — Redaction and annotations

User can mark tables, columns, or schemas as excluded or sensitive. Sensitive entities are sent to the LLM with obfuscated names and de-obfuscated on the way back. User can write annotations on tables and columns that get included in the prompt to improve generation quality.

**Done when:** A user can extract a schema, mark three tables as excluded and two columns as sensitive, ask a question, and verify in the request log that the excluded tables are absent and the sensitive columns are obfuscated.

## Phase 9 — Polish and packaging

Signed installers for macOS (notarized), Windows (Authenticode), Linux (AppImage and deb). First-run onboarding flow. In-app documentation pack for security review. Settings UI for telemetry opt-in. UX overhaul.

**Done when:** A user can download the app from a clean machine, install it, follow onboarding to validated SQL ready to copy out, and the security team has a single PDF they can review.

The "working query" wording from earlier drafts of this doc has been adjusted: Phase 9 also removed the in-app run-query path entirely (see `docs/architecture/query-execution.md`). The done-when criterion is now "validated SQL ready to copy" rather than "results displayed in the app."

This phase is split into 9a (in-app, shipped) and 9b (real-world signing infrastructure, separate work):

- **9a — shipped:**
  - First-run onboarding wizard (welcome → provider → connection → schema → done)
  - Security review PDF via `printpdf`, generated locally, listing the security model + current configuration + endpoints + verbatim extraction queries
  - Telemetry opt-in toggle (placeholder; no payload sent in this build)
  - Tauri bundle config for `msi` / `nsis` / `dmg` / `appimage` / `deb`
  - `.github/workflows/build.yml` producing unsigned installers on each OS — finally moves BUGS.md #10 (cross-OS verification) forward
  - **UX overhaul** in response to user feedback during testing: removed the run-query button and the entire `execute_query` backend; restructured the home into three sections (schema, ask, generated SQL) with a top-bar nav and modal dialogs for providers / connections / settings / security review; added syntax-highlighted SQL with click-to-copy; added in-memory session history of past Q+SQL pairs.

- **9b — blocked on real-world resources:** macOS notarization (Apple Developer Program account, Mac builder); Windows Authenticode (code-signing cert from a CA); Linux deb GPG signing; distribution channels (Homebrew, winget, apt repo). See `docs/PHASE_9B_DEFERRED.md` for the named revisit conditions.

## Phase 10 — Windows widget mode

Floating widget as the primary UI on Windows, summoned by a global hotkey, backed by a system tray icon. Implements ADR 0014. The existing main window stays as the admin surface (settings, schema review, redaction, history); the widget is for the hot path (ask → SQL → copy).

**Done when:** A user on Windows can press `Ctrl+Shift+Space`, see the widget appear with the textarea focused, type a question, get validated SQL back, copy it, and dismiss the widget — all without the widget ever being more than two clicks away from the IDE underneath. The widget renders all six states from the design spec (default, streaming-as-spinner, generated, validation error, empty/no-schema, pill collapsed). Position, last question, and last generated SQL persist across launches.

Streaming SQL output is explicitly out of scope for Phase 10 — the "Streaming" state in the design spec is implemented as a single spinner. Token-by-token streaming would touch the LLM provider abstraction; revisit in a follow-up phase if user feedback shows it matters.

See `docs/PHASE_10_KICKOFF.md` for the full kickoff doc.

## Phase 11 — Widget polish (done)

Multi-monitor position memory, hotkey customization UI, auto-start on Windows boot, surfacing hotkey-conflict errors, multi-database connection picker in the widget, and a series of fixes that surfaced once the user actually started using the widget on Windows.

**Done when:** the rough edges from Phase 10 are addressed and the widget feels native on Windows — opens after reboot, restores to the right monitor, doesn't conflict with other apps' hotkeys (and tells you when it does), is draggable, has clean rounded corners, is consistent with the main window's visual language, and users with multiple saved databases can switch between them without leaving the widget.

What ships:

- **Hotkey customization.** Settings → Widget hotkey shows the current binding and a "Change" button. Click → press a combo with at least one modifier → the new hotkey is registered (or the registration failure is surfaced inline). Stored as a `widget_hotkey` row in the `settings` table; default `Ctrl+Shift+Space` (the previous draft used `CommandOrControl+...` but that legacy alias didn't always parse in `tauri-plugin-global-shortcut` 2.x; we now also retry with the hardcoded default if the saved value fails to register).
- **Hotkey-conflict error surfaced in the UI.** If startup-time registration fails (another app already owns the combo), `widget_hotkey_error` is written to settings and the Settings dialog shows a banner pointing the user to rebind.
- **Multi-monitor position safety.** When the widget is summoned (hotkey, tray click, or `show_widget` command), `ensure_widget_on_visible_monitor` checks whether at least 80px of the widget overlaps a connected monitor. If not (the user disconnected the monitor it was on, or it's the first show with no saved position), the widget is repositioned to the top-right of the primary monitor with a 24px margin. Saved positions that are still valid are respected.
- **Auto-start on Windows boot.** `tauri-plugin-autostart` ships behind a Settings → "Start with Windows" toggle. Off by default. The widget stays hidden in the tray on launch; only the hotkey or tray click brings it forward, so auto-start does not slow login.
- **Widget polish to match the prototype.** Material Symbols-style inline SVG icons (no font CDN, per the security model), proper `Ctrl ↵` shortcut chip on the Generate button, box-shadow ring-pulse on the status dot, schema-pill format `{schema_name} · N tables`, error banner with strong title + secondary detail, footer states with their own colors and icons, and the pill's expand chevron is now a real button so you can click it without the drag region eating the event.
- **Main app aligned to the widget's design language.** App.css rewritten against the widget's CSS tokens (`--bg`, `--surface`, `--primary`, etc.). Both windows now share the same dark Material 3-inspired palette, Inter / JetBrains Mono typography, button shapes, dialog styling, and code-block syntax colors. No dark-mode media query — the app is dark-only.
- **Window resize moved from JS to Rust.** Earlier the pill could render at full-screen size if the JS-side `setSize` raced the React mount. New `apply_widget_size_from_store` (called before `widget.show()`) and `apply_widget_size` (called by `set_widget_pill_mode`) keep the window dimensions in lockstep with the persisted `pill_mode` flag, no race possible.
- **Transparent widget window.** Set `transparent: true` in `tauri.conf.json` so the area outside the widget's rounded HTML shape shows the desktop instead of WebView2's default white bleed. CSS `box-shadow` on the widget element provides the visible drop shadow so it tracks the rounded outline.
- **Multi-database connection picker (ADR 0015).** When more than one connection profile is saved, the widget header shows the active connection as a clickable picker. A fixed-position overlay lists all profiles with schema age and a per-profile refresh button. Switching connections loads the new schema inline; any previously generated SQL dims with a "from previous connection" notice until the user generates fresh SQL for the new connection. Single-profile users see no change.

The auto-hide-on-focus-loss behavior (originally Raycast-style) was removed: starting an OS drag transfers focus to the window manager, which fired the hide handler before the user could complete the drag. The widget now stays visible until explicitly dismissed (Esc, the close button, or clicking the tray icon).

## Phase 12 — First five users (current)

Get five target users (regulated mid-market data engineers) using the app weekly. Iterate based on what they actually struggle with. Do not add features that no user asked for.

**Done when:** Five users have used the app every week for four consecutive weeks. We have written notes on the top three friction points from each.

What shipped during Phase 12 iterations (before first external users):

- **Security hardening.** `cipher_memory_security = ON` (SQLCipher zeros pages before freeing), `zeroize` crate wraps the 32-byte key so it is wiped from memory on drop, write-access detection on test-connection (warns the user if their DB role has INSERT/UPDATE/DELETE grants).
- **OS keychain for the SQLCipher key (ADR 0016).** On Windows the 32-byte key moved from a file sitting next to the encrypted store into Windows Credential Manager (DPAPI-encrypted per user, `CredWriteW`/`CredReadW` via `windows-sys`). Existing installs migrate automatically on first launch after upgrade — no user action required.
- **Opt-in session context and follow-up suggestions (ADR 0017).** Two independently toggleable settings (both off by default). Session context sends the last ≤5 Q+SQL pairs from the current session alongside the next question so users can ask natural follow-ups. Follow-up suggestions fires a second lightweight LLM call after each generation and renders 3 clickable question chips. Both are clearly labelled opt-in so users with conservative postures know what goes to the provider.
- **One-click update launcher.** `update.bat` in the project root rebuilds from source (handles Strawberry Perl PATH), closes the running app, and launches the NSIS installer — replaces the manual PowerShell sequence.
- **Neon ;) logo.** App icon replaced with a 512×512 SVG — dark navy background, neon cyan `";)"` in Courier New Bold, rotated 90° CCW so the `)` becomes an upward smile and the `;` dots become side-by-side eyes, with a three-layer glow filter. All platform icon variants (`.ico`, `.icns`, APPX tiles, Android mipmap, iOS) regenerated via `pnpm tauri icon`. `public/favicon.svg` added; scaffold `vite.svg` and `tauri.svg` removed. Version bumped to 0.2.0.
- **Two-column SQL alignment.** The PostgreSQL and MySQL system prompts now instruct the LLM to pad every top-level clause keyword to 10 characters so clause content always starts at column 11. `AND`/`OR`/`NOT` stay inline on their parent clause line. `GROUP BY` and `ORDER BY` use 2 trailing spaces to reach the same column. See `docs/architecture/sql-generation.md` for the formatting spec.
- **Main-window history dialog and feature-toggle discoverability.** A "History" button appears in the topbar nav when a connection profile is selected; clicking it opens a modal listing the last 100 queries for that connection (timestamp, question, SQL, validation badge). The "Ask a question" card header now shows "Session context ON/OFF" and "Suggestions ON/OFF" pill toggles directly — previously these were buried in the Settings dialog and invisible to new users. All topbar nav buttons light up in primary blue while their dialog is open.
- **Widget: feature toggles and history panel.** The floating widget is the primary mode of use; both features were unreachable from it. Two compact chip toggles (Context ON/OFF, Suggestions ON/OFF) now appear between the question textarea and the action row in the widget body. A history icon (clock) button in the header opens an inline history panel showing the last 50 queries for the active connection; clicking any entry pastes the question into the textarea and closes the panel. Esc closes the history panel before hiding the widget.
- **Design polish (full design-critique pass).** Unified design token system across both windows: `--text-dim` raised to `#9499a8`, `--validated` raised to `#7dcc7d`, full `--radius-sm/md/lg/xl/pill` scale introduced and used everywhere in place of ad-hoc px values. Focus rings added (`focus-visible` + box-shadow glow) on all inputs and buttons. `.icon-btn` touch target in the widget raised from 24×24 to 28×28 px. `.badge-ok` legibility fixed with border. Dialog close button given a 32×32 touch target. Schema names use `--primary-dim` (accent) rather than `--primary` (CTA). `color-scheme: dark` on all text inputs prevents WebView2 from overriding background to white.
- **Release build OOM fix.** Changed `codegen-units` from 16 to 1 in `[profile.release]`. The 16-unit default caused 16 simultaneous mmap operations of large dependency `.rlib` files, exhausting the Windows paging file (os error 1455). Single-unit codegen serialises these; compile time is unchanged at `opt-level = 0`.

## Out of scope for v1

These come after phase 9 if the product has traction.

- Team mode / shared annotations
- Audit log export for enterprise
- Saved query library
- File-based schema ingestion (PDF, SVG, SQL DDL upload)
- Self-hosted LLM first-class UI
- Mobile or web companion
- Auto-updating schema on a schedule
