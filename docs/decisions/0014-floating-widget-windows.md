# ADR 0014: Floating widget as primary UI on Windows

## Status

Accepted.

## Context

Through Phase 9, the app shipped as a conventional desktop window —
the user opens it like any other app, asks questions, copies SQL,
switches to their IDE to run it. User research and our own
walk-throughs showed that the context-switch between the app and
the IDE was the single largest source of friction. The whole point
of the tool — fast, low-overhead SQL composition — is undermined
when the user has to alt-tab on every question.

A floating widget that sits on top of whatever IDE the user is in
collapses that friction. The user never leaves their IDE; the
widget appears on hotkey, accepts a question, returns SQL, and
gets out of the way. This matches the interaction pattern of tools
the target user is already comfortable with (Raycast, PowerToys
Run, 1Password Quick Access).

We are shipping Windows-first. macOS and Linux are deferred. The
target buyer (regulated mid-market data engineer) is heavily
Windows-skewed, and committing to one OS lets us polish the
experience rather than spread thin across three.

## Decision

The widget becomes the primary UI on Windows. The existing
desktop window is retained but reframed as the admin surface
(settings, schema review, redaction, history). Day-to-day use
happens in the widget.

The widget is:

- A frameless always-on-top window, ~400px wide, ~500px tall when
  expanded, no taskbar entry.
- Summoned by a global hotkey (default Ctrl+Shift+Space, user-
  configurable in settings).
- Persistent across sessions — last position, last question, and
  last generated SQL are restored on reopen.
- Backed by a system tray icon that shows app status (ready / no
  schema / API key missing) and provides a menu (Show widget,
  Open main window, Settings, Quit).
- Collapsible to a small pill (~220px × 30px) that floats in a
  user-chosen screen position. Click the pill to expand, drag to
  move. The pill is an alternative minimized state to the tray
  icon — both exist; the user picks which they prefer in settings.

The visual design is locked to a baseline aesthetic captured in
`docs/design/widget-prototype.html` and documented in
`docs/design/widget-design-spec.md`. Future phases that change the
widget UI must update both. Note that the prototype is aesthetic
reference only — it includes elements (e.g. a "Run in Console"
button) that explicitly do not apply, called out in the prototype
header and the spec doc.

## Rationale

- The widget collapses the IDE-switching friction that was the
  single largest pain point in the desktop-window design.
- The shape (frameless, always-on-top, hotkey-summoned, system
  tray backed) is the established Windows-native pattern for
  helper utilities. Users do not need to be taught the model.
- Restricting to Windows lets us polish — multi-OS support fragments
  attention across rendering quirks, hotkey conflicts, clipboard
  edge cases, and platform-specific UI conventions, none of which
  the target user benefits from.
- The main window is preserved unchanged. Schema review,
  redaction, history, and settings continue to work as they did.
  This means the widget is additive to the architecture, not a
  replacement.

## Tradeoffs accepted

- **Windows-only narrows the addressable market.** Mac- and Linux-
  using data engineers cannot use the tool. Acceptable for v1;
  cross-platform is a post-revenue investment.
- **Two windows means more state to keep in sync.** The widget
  and main window both observe the same backend state (active
  schema, active provider, history). The Rust core is the source
  of truth; both windows are views. This requires discipline
  around event propagation but is well-trodden Tauri territory.
- **Always-on-top has rendering edge cases on Windows.** WebView2
  occasionally glitches when an always-on-top window crosses
  monitors with different DPI. We handle the common cases and
  accept rare visual artifacts on multi-monitor setups.
- **The pill and the tray icon overlap in purpose.** Some users
  will use one, some the other, some both. We accept the slight
  redundancy in exchange for letting users pick what fits their
  workflow.

## Alternatives considered

- **Browser extension.** Rejected — it would put the tool inside
  the browser, but most data work happens in DataGrip / DBeaver /
  pgAdmin, not in the browser. Wrong host application.
- **IDE plugin per IDE.** Rejected — each plugin is its own
  ecosystem (JetBrains, VS Code, dbt) and we'd be perpetually
  behind on plugin maintenance. Cross-IDE coverage by being
  outside any IDE is the cleaner shape.
- **Stay with a conventional desktop window.** Rejected based on
  user research showing the IDE-switching friction was the
  primary blocker.

## Security implications

None new. The widget is a window. It does not read the screen,
does not capture keystrokes outside its own input box, does not
have any awareness of what application is underneath it. The data
flow is identical to the desktop-window version: schema metadata
to the configured LLM, never row data, never our infrastructure.

The "always-on-top" property is sometimes assumed to imply
something more invasive (overlay sensing, screen capture). The
security review pack must explicitly state that it does not.
