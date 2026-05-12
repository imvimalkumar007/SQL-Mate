# Widget design spec

This document is the source of truth for the widget's visual and
interaction design. Any UI change to the widget must update this
file and the prototype together.

The reference prototype is at `docs/design/widget-prototype.html`.

## Dimensions

- Expanded widget: 400px wide × ~500px tall (height grows with
  SQL output up to a max, then code block scrolls internally)
- Minimum widget height: 280px (empty state)
- Pill: 220px × 30px
- Border radius: 10px on the widget, 999px on the pill
- Drop shadow: 0 16px 40px rgba(0, 0, 0, 0.45)

## Color tokens

These are the only colors used in the widget. Define as CSS
custom properties; do not introduce others without updating this
spec.

| Token | Value | Used for |
|---|---|---|
| --bg | #131313 | App background |
| --surface | #1b1b1c | Widget header / footer background |
| --surface-2 | #202020 | Widget body background |
| --surface-3 | #2a2a2a | Pill background, hover states |
| --surface-4 | #353535 | Deep hover / pressed states |
| --border | #424754 | Primary border |
| --border-soft | #303035 | Internal dividers |
| --text | #e5e2e1 | Primary text |
| --text-muted | #c2c6d6 | Secondary text |
| --text-dim | #9499a8 | Tertiary / placeholder text (raised from #8c909f for AA contrast) |
| --primary | #adc6ff | Status dot, primary button, model name |
| --primary-dim | #4d8eff | Interactive accents, focus rings, active states |
| --primary-fg | #002e6a | Foreground on primary button |
| --code-bg | #0e0e0e | SQL output background |
| --kw | #adc6ff | SQL keywords |
| --fn | #ffb786 | SQL function names |
| --str | #a4c9ff | SQL string literals |
| --danger | #ffb4ab | Error text |
| --danger-bg | #93000a | Error backgrounds (with low alpha) |
| --validated | #7dcc7d | Validated status text and badges (raised from #6cba6c for legibility) |

## Radius tokens

Use these instead of ad-hoc px values.

| Token | Value | Used for |
|---|---|---|
| --radius-sm | 4px | Small chips, code inline, icon-btn |
| --radius-md | 6px | Inputs, code blocks, error banner, generate button |
| --radius-lg | 10px | Widget shell outer border |
| --radius-xl | 12px | (reserved for dialogs — main window only) |
| --radius-pill | 999px | Pill shape, suggestion chips, toggle chips |

## Typography

- UI font: Inter, system fallback
- Monospace font: JetBrains Mono, system monospace fallback
- Field labels: 10px, uppercase, letter-spacing 0.1em, weight 500
- Body text: 13px, weight 400
- Code: 12px JetBrains Mono, line-height 1.55
- Connection/model context label: 11px JetBrains Mono
- Footer telemetry: 10px JetBrains Mono

## Layout (top to bottom)

1. **Header** (32px tall) — drag region. Status dot, context
   label (`connection_name · Model Name`), four icon buttons
   (minimize-to-pill, history, open-main-window, hide-to-tray).
   The history button renders with a primary-blue tint while the
   history panel is open (`.icon-btn--active`).
2. **Body** (variable) — padded 12px on all sides. Two views:

   **Normal view:**
   - Field label "Ask"
   - Question textarea (min 64px, grows to ~120px max)
   - Toggle chip row: "Context ON/OFF" + "Suggestions ON/OFF"
     (10px, pill-shaped, gap 4px; both default off)
   - Action row: schema pill (left) + Generate button (right)
   - Error banner (validation-error state only)
   - Output section: "SQL" label + Copy button on right
   - Code block (or empty/streaming state)
   - Suggestion chips (when Suggestions is on and SQL was generated)

   **History panel view** (replaces body when history icon is active):
   - Header row: "Recent queries" label + "✕ close" button
   - Scrollable list of past queries, newest first. Each row:
     question text (ellipsis), relative age, ✓/✗ badge.
     Clicking a row pastes the question into the textarea and
     closes the panel.

3. **Footer** (28px tall) — status text on left, hotkey hint or
   secondary info on right.

## States

Seven distinct states:

1. **Default** — schema loaded, no question yet. Empty textarea
   with placeholder, code block shows "SQL appears here after
   you generate." Status dot pulses primary blue.
2. **Generating** — question submitted. Generate button replaced
   with spinning indicator and "Generating" label. Code block has
   a blinking cursor. Footer reads "esc to cancel."
3. **Generated** — SQL complete and validated. Copy button
   active. Footer shows latency with a speed icon, and a green
   "validated" stat. If Suggestions is on, 3 chip buttons appear
   below the code block.
4. **Validation error** — SQL generated but rejected. Status
   dot turns danger red (no animation). Inline error banner
   above the (greyed-out) code block explains why. Generate
   button label becomes "Try again." Footer reads "rejected."
5. **Empty / no schema** — first run or no schema loaded. Body
   replaced with centered empty state: schema icon, "No schema
   loaded" title, one-line description, "Open settings →" link.
   Status dot is text-dim color, no animation. Header context
   label reads "no schema loaded" in dim text.
6. **Pill (collapsed)** — the entire widget collapses to a 220×30
   pill showing status dot, connection name, model name, and a
   chevron. Click to expand back to the widget.
7. **History panel** — replaces the normal body. Shows the last
   50 queries for the active connection. Activated by the history
   icon button in the header; dismissed by clicking "✕ close",
   pressing Esc, or clicking any history entry.

## Interaction details

- The textarea autofocuses when the widget appears (whether by
  hotkey or click).
- Ctrl+Enter submits the question.
- Esc priority: (1) close connection picker if open, (2) close
  history panel if open, (3) hide widget to tray.
- Ctrl+C with focus in the code block copies the SQL.
- The header is a drag region — clicking and dragging anywhere
  in the header moves the widget. Position persists across
  sessions.
- The pill is also fully draggable.
- Hover states use `--surface-3` background on icon buttons.
  Active history button uses `--icon-btn--active` (primary tint).
- The status dot pulses in default and generated states, holds
  steady (no animation) in error and empty states.
- Feature toggle chips write through to the shared settings
  table immediately; the main window and widget always reflect
  the same state.
- History icon button only appears when a connection profile is
  active (it requires a `connection_id` to query).

## Hard constraints

- No transparency, no blur effects, no gradients. Solid surfaces
  only. (A future polish iteration may revisit transparency once
  core flows are stable.)
- No animation longer than 200ms except the status-dot pulse and
  the streaming cursor blink.
- No font weights between 400 and 500. Two weights only.
- No font sizes below 10px.
- The widget must remain usable at the documented dimensions
  without horizontal scroll on any element except the code block.

## Reference prototype

Open `docs/design/widget-prototype.html` in a browser. All six
states are rendered there at actual size. When making any UI
change, update both this spec and the prototype together so they
remain consistent.
