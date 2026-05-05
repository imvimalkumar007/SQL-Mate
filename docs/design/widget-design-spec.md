# Widget design spec

The load-bearing constraints for the floating widget shipped under
ADR 0014. The visual reference is
`docs/design/widget-prototype.html`. Where the prototype and this
spec disagree, this spec wins. The prototype is aesthetic guidance,
not a feature list.

This is a stub. It captures the rules a future implementation phase
must respect; it does not yet specify pixel-level layout, component
hierarchy, or React structure. Those land in the implementation
phase's kickoff doc.

## Out of scope (must not appear in the widget)

These are non-negotiable. They override anything in the prototype.

1. **No execution affordances.** No "Run" button, no "Run in Console"
   button, no "Execute" command, no inline result preview, no row
   table. Per ADR 0014's reaffirmation of SECURITY_MODEL.md T2 and
   the Phase 9 removal documented in
   `docs/architecture/query-execution.md`, the app does not run
   generated SQL. The widget produces validated SQL and exposes a
   click-to-copy affordance only.
2. **No screen reading, no keystroke capture, no overlay sensing.**
   The widget is a window. It only reads its own input box. The
   security review pack must be able to confirm this by inspecting
   the Tauri capabilities manifest.
3. **No telemetry payload.** The Phase 9 telemetry-opt-in toggle
   continues to ship in the main window's settings; the widget
   does not surface it and does not send anything regardless of
   the toggle state.
4. **No feedback collection.** Thumbs-up / thumbs-down buttons in
   the prototype's footer are aesthetic placeholders only.
5. **No "Snippets" feature.** Not in the product.

## Load-bearing widget behavior

These come straight from the ADR. The implementation must hit all
of them.

| Property | Value |
|---|---|
| Frame | Frameless (no titlebar, no border chrome) |
| Z-order | Always-on-top |
| Taskbar | No taskbar entry |
| Default size (expanded) | ~400 px wide × ~500 px tall |
| Default size (pill) | ~220 px wide × ~30 px tall |
| Summon hotkey (default) | `Ctrl+Shift+Space` |
| Hotkey rebindable | Yes, in main-window settings |
| Persistence on close | Last position, last question text, and last generated SQL are restored on next summon |
| System tray icon | Yes — shows app status + menu (Show widget · Open main window · Settings · Quit) |
| Status states | `ready` · `no schema` · `no provider` · `error` |
| Pill alternative | Always available; user picks pill vs tray icon (or both) in settings |
| Drag | Pill draggable; expanded widget draggable from a top "grip" region |
| Multi-monitor | Position remembered per monitor; falls back to primary if last monitor is gone |

## Widget content (when expanded)

In rough order top-to-bottom:

1. **Compact header.** Title + close (collapses to pill / tray) +
   "open main window" link. Optional drag-handle region.
2. **Active context line.** "Connection: <name> · Model: <name>"
   in muted small type, click to open the relevant main-window
   modal (no duplicate provider/connection editing inside the
   widget).
3. **Question input.** Multi-line textarea, autofocused on summon,
   submit on Cmd/Ctrl+Enter.
4. **Generate button.** Primary action. Disabled if no provider
   or no schema.
5. **Generated SQL block.** Same `SqlBlock` component as the main
   window — syntax-highlighted, copy button, validation status.
6. **Validation status.** Pass/fail line, no expanded request log
   in the widget (request log lives in the main window).
7. **Recent.** Last 3 session-history entries inline, scrollable.
   Full session history lives in the main window.

## What the widget delegates to the main window

The widget is for the hot path: ask → SQL → copy. Everything else
is in the main window:

- Provider configuration (add / remove / edit API keys)
- Connection profiles (add / remove / edit)
- Schema extraction
- Schema review and redaction
- Annotation editing
- Settings (telemetry, hotkey rebinding)
- Security review pack export
- Full session and persisted history

Clicking provider or connection in the widget's active-context line
opens the relevant modal in the main window, which gets focus.

## Visual language (from the prototype)

- **Color palette:** Material 3 dark theme. Primary `#adc6ff`
  (cool blue), surface `#131313`, surface-container `#202020`,
  outline-variant `#424754`, code background `#121212`.
- **Typography:** Inter 400/500/600/700 for UI text; JetBrains
  Mono for code. Headline 1.25 rem / 600, body 0.875 rem / 400,
  label 0.75 rem / 500, code 0.8125 rem.
- **Spacing scale:** xs 0.25 rem · sm 0.5 rem · md 1 rem ·
  lg 1.5 rem · xl 2 rem.
- **Border radius:** default 0.125 rem, lg 0.25 rem, xl 0.5 rem.
- **SQL syntax highlighting tokens:** keyword `#adc6ff`, function
  `#ffb786`, string `#a4c9ff`. (Maps onto the existing `SqlBlock`
  component's token classes; the implementation phase decides
  whether to keep the existing token names or rename to match.)

## Things explicitly punted to the implementation phase

- React structure: separate widget app vs subset of the main app's
  bundle.
- Tauri configuration: separate window definition vs single window
  with multiple roles.
- Hotkey registration: which crate or Tauri plugin.
- Tray icon platform integration: Tauri's built-in tray API vs a
  plugin.
- Pixel-level component layout and animations.
- How to handle the Phase 9 onboarding wizard from the widget
  (probably: widget refuses to be useful until the main window's
  onboarding is complete; widget surfaces a "complete setup" link).
- macOS / Linux: explicitly out of scope; reopen this spec when
  cross-platform work is unblocked.
