# Phase 10 kickoff: Windows widget mode

This document is the entry point for Claude Code's working session
on the floating widget. It implements ADR 0014.

## Reading order

1. CLAUDE.md — refresh on working norms
2. `docs/decisions/0014-floating-widget-windows.md` — the ADR
3. `docs/design/widget-design-spec.md` — the design spec
4. `docs/design/widget-prototype.html` — open this in a browser before
   writing any UI code, look at all six states (note: the current
   prototype only renders the "generated" state; the spec is
   authoritative for the others)
5. `docs/architecture/ui-flows.md` — current UI flows that the widget
   needs to support

## What this phase delivers

A working Windows widget that pairs with the existing main window.
Per ADR 0014.

**Done when:**

- A second Tauri window exists, configured frameless, always-on-top,
  no taskbar entry, 400×500.
- A system tray icon is present with a right-click menu (Show
  widget, Open main window, Settings, Quit). Left-click toggles
  the widget.
- A global hotkey (default Ctrl+Shift+Space) summons the widget
  with the textarea autofocused. Hotkey is registered via
  tauri-plugin-global-shortcut.
- The widget renders all six states from the design spec: default,
  streaming, generated, validation error, empty/no-schema, pill.
- The pill state is implemented as a window resize (220×30); the
  same window swaps between the pill dimension and the expanded
  dimension. Position persists across collapse/expand.
- The widget calls the same Rust commands the main window does
  (generate_sql, validate_sql, list_schemas, etc.). The one new
  backend surface is a `widget_state` table for position + last
  question + last SQL persistence.
- LLM responses do NOT stream in this phase — see "Streaming"
  below for why and where it's deferred to.
- Position, last question, and last generated SQL persist to the
  schema store and restore on next launch.
- All polish requirements from CLAUDE.md and the design spec are
  met (no font below 10px, no animation over 200ms, etc.).
- All commits are on the `phase-10/widget` branch with `phase-10:`
  prefixes.

## What this phase does not deliver

- **Streaming SQL output.** The original kickoff called for token-
  by-token streaming. The current LLM provider abstraction returns a
  complete `SqlGenerationResponse` in one shot; adding streaming
  would touch the provider trait, both Anthropic and OpenAI HTTP
  clients, and the Tauri event surface — not "purely a new view."
  The "Streaming" state in the spec is implemented as a single
  spinner ("Generating…") in this phase. True streaming is a
  follow-up phase if user feedback shows it matters.
- Multi-monitor position memory edge cases. Single-monitor only
  for v1; multi-monitor is Phase 11.
- Hotkey customization UI. The default hotkey is hardcoded for
  this phase; the customization UI ships in Phase 11.
- macOS or Linux support. Per ADR 0014, Windows-only.
- Auto-start on Windows boot. Phase 11.
- Transparency or blur effects. Per the design spec.
- Any change to the LLM provider abstraction, the validator, or
  the schema-extraction pipeline. The widget is a new view onto
  existing commands plus one persistence table.

## Confirmed decisions

### Default hotkey

Ctrl+Shift+Space. Hardcoded for this phase. Customization is
Phase 11. If the hotkey is unavailable (already registered by
another app), surface a clear error in the main window and
prompt the user to wait for Phase 11's customization UI.

### Pill vs. tray for minimized state

Both exist. The tray icon is always present. The pill is opt-in
via settings; default is "tray only." This avoids cluttering
the user's screen by default while letting power users who
prefer a visible always-on indicator opt in.

### Window state persistence

Last widget position (x, y), last question text, and last
generated SQL persist to the existing SQLCipher store under a
new `widget_state` table (migration 0004). On reopen the widget
restores these. Cleared if the user clicks "new question" or
after 24 hours of inactivity.

### Validation error UI

Per the design spec: inline error banner in the widget body,
above the code block. The user does not leave the widget to
read the error. Generate button label becomes "Try again."

### Active connection display

The header context label always shows
`{connection_name} · {model_name}`. If multiple connections
exist, the widget uses the connection most recently active in
the main window. Switching connections happens in the main
window, not the widget.

### Two windows, one Tauri app

The widget and the main window are two windows declared in
`tauri.conf.json` with different URLs / dev-server entry points.
The Vite config is configured for multi-page output so each
window can have its own bundle. The Rust core is the source of
truth; both windows are views.

### System tray uses Tauri 2 core, not a separate plugin

`tauri::tray::TrayIconBuilder` is in Tauri 2 core (with the
`tray-icon` cargo feature). The original kickoff listed
`tauri-plugin-system-tray` but that plugin is for Tauri 1; for
Tauri 2 the API moved into core.

## What to ask before coding

Per CLAUDE.md, ask before:

- Adding any new Tauri plugin not listed (we need:
  `tauri-plugin-global-shortcut` and the `tray-icon` cargo
  feature on the existing `tauri` dep).
- Changing the design spec or the prototype.
- Persisting any data not listed in "Window state persistence"
  above.
- Touching the LLM provider abstraction, the validator, or the
  schema-extraction pipeline. None of these should change.

Don't ask, just do:

- Pick reasonable React state shape for the widget.
- Pick reasonable IPC patterns between the two windows (Tauri
  events).
- Add tests for the new state-persistence code.
- Match the design spec exactly. If something in the spec is
  ambiguous, default to what the prototype renders (only the
  "generated" state has a literal prototype rendering; the other
  five must follow the spec text).

## Workflow

1. Branch: `phase-10/widget` from main, with the unmerged
   phase-9 UX overhaul tip and the `docs/adr-0014-floating-widget`
   docs already merged in (the phase-9 PR was merged as #6 but
   that PR only contained Phase 9a polish + packaging; the UX
   overhaul commits are merged into phase-10/widget directly).
2. Add `widget_state` table migration + store CRUD.
3. Add `tauri-plugin-global-shortcut` and the `tray-icon` cargo
   feature to the existing `tauri` dep.
4. Add the second window to `tauri.conf.json` with the
   documented properties.
5. Wire the system tray icon and menu in `src-tauri/src/lib.rs`.
6. Register the global shortcut and add `show_widget`,
   `hide_widget`, `toggle_widget`, `collapse_widget`,
   `expand_widget` Tauri commands.
7. Configure Vite for multi-page output (main window + widget
   window).
8. Build the widget React component, matching the design spec
   state by state.
9. Wire the widget to the existing Rust commands (no new
   provider/validator/extraction work).
10. Add state persistence (position, last question, last SQL).
11. Test all six states by hand, with the prototype open in a
    second window for visual reference.
12. Commit incrementally with `phase-10:` prefixes.
13. Push and tell the user when ready for review.

## Visual verification

Open `docs/design/widget-prototype.html` alongside the running
app during development. The "generated" state in the prototype
should look indistinguishable from the corresponding state in
the actual widget. The other five states are not in the
prototype — match the spec text instead. Differences in font
rendering between WebView2 and Chrome are acceptable;
differences in layout, color, spacing, or typography hierarchy
are not.

A follow-up docs PR should expand the prototype to render all
six states once the widget is implemented and the visual
language for the other states has been validated against the
spec in real WebView2.
