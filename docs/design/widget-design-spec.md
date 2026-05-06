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
| --border | #424754 | Primary border |
| --border-soft | #303035 | Internal dividers |
| --text | #e5e2e1 | Primary text |
| --text-muted | #c2c6d6 | Secondary text |
| --text-dim | #8c909f | Tertiary / placeholder text |
| --primary | #adc6ff | Status dot, primary button, model name |
| --primary-fg | #002e6a | Foreground on primary button |
| --code-bg | #0e0e0e | SQL output background |
| --kw | #adc6ff | SQL keywords |
| --fn | #ffb786 | SQL function names |
| --str | #a4c9ff | SQL string literals |
| --danger | #ffb4ab | Error text |
| --danger-bg | #93000a | Error backgrounds (with low alpha) |

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
   label (`connection_name · Model Name`), three icon buttons
   (minimize-to-pill, settings, hide-to-tray).
2. **Body** (variable) — padded 12px on all sides.
   - Field label "Ask"
   - Question textarea (min 64px, grows to ~120px max)
   - Action row: schema pill (left) + Generate button (right)
   - Output section: "SQL" label + Copy button on right
   - Code block (or empty/error/streaming state)
3. **Footer** (28px tall) — status text on left, hotkey hint or
   secondary info on right.

## States

Eight distinct states, all rendered in the prototype:

1. **Default** — schema loaded, no question yet. Empty textarea
   with placeholder, code block shows "SQL appears here after
   you generate." Status dot pulses primary blue.
2. **Streaming** — question submitted, SQL appearing token by
   token. Generate button replaced with spinning indicator and
   "Generating" label, becomes disabled. Code block has a
   blinking cursor at the streaming position. Footer reads
   "streaming · esc to cancel."
3. **Generated** — SQL complete and validated. Copy button
   active. Footer shows latency, token count, and a green
   "validated" stat.
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
7. **Connection picker open** — the picker in the header is open,
   showing all configured connections in a floating menu above (or
   below) the header. The active connection has a check mark. Stale
   connections (schema > 7 days old) show the age in `--danger` and
   a refresh icon. Connections with no cached schema appear dimmed
   and labelled "no schema yet."
8. **After connection switch** — a new connection has been selected.
   The header context label and schema pill reflect the new
   connection. Any previously generated SQL is greyed out
   (`opacity: 0.45`) with a "from previous connection" label in dim
   10px JetBrains Mono above the code block. The question textarea
   is unchanged. The Generate button is ready.

## Connection picker

Replaces the static connection name in the header context label.
Present whenever more than one connection profile is configured.

### Placement

The connection name portion of the header context label becomes a
picker button. The status dot remains to its left; the separator
and model name remain to its right. The picker button is the only
non-drag zone in the header.

### Collapsed appearance

- Connection name in `--text-muted`, 11px JetBrains Mono
- `expand_more` chevron (13px, `--text-dim`) immediately to the
  right of the name
- Hover: `--surface-3` background, 4px border-radius, text to `--text`
- Open state: same as hover; chevron flips to `expand_less`

### Expanded floating menu

- Width: 400px (matches widget); anchors to widget left edge
- Opens **upward** when the widget's top edge is below the screen's
  vertical midpoint; opens **downward** otherwise
- Background: `--surface`; border: 1px `--border`; border-radius:
  8px; box-shadow: `0 8px 24px rgba(0,0,0,0.5)`
- Each row: connection name (12px JetBrains Mono, `--text`) on
  line 1, schema age (10px JetBrains Mono, `--text-dim`) on line 2;
  10px padding top and bottom, 12px left and right
- Active connection: `--surface-2` background; `check` icon (14px,
  `--primary`) on the right
- Rows separated by 1px `--border-soft` dividers; hover `--surface-3`

### Stale schema affordance (schema > 7 days old)

- Schema age text in `--danger` instead of `--text-dim`
- `refresh` icon button (16px) on the right; `--text-dim` default,
  `--primary` on hover
- Clicking the icon triggers metadata extraction without closing
  the menu; the widget never auto-refreshes schema

### "No schema yet" state

- Connection name in `--text-dim`; schema age line reads "no schema
  yet" in `--text-dim`, italic; no refresh affordance
- Selecting the row does not switch the connection; the menu closes
  and a notice appears above the Generate button: "Extract this
  connection's schema in the main window before asking questions."

### Connection-switch state transitions

On selecting a connection with a cached schema:

1. Menu closes; header context label updates to the new connection name
2. Schema pill updates to the new connection's schema summary
3. Displayed SQL greys out (`opacity: 0.45`); "from previous
   connection" label (10px JetBrains Mono, `--text-dim`) appears
   above the code block
4. Question textarea content is preserved
5. Generate button is enabled, ready for the next question

## Interaction details

- The textarea autofocuses when the widget appears (whether by
  hotkey or click).
- Cmd/Ctrl+Enter submits the question.
- Esc dismisses the widget back to tray (or pill, depending on
  user preference).
- Cmd/Ctrl+C with focus in the code block copies the SQL.
- The header is a drag region — clicking and dragging anywhere
  in the header moves the widget. Position persists across
  sessions.
- The pill is also fully draggable.
- Hover states use `--surface-3` background on icon buttons.
- The status dot pulses in default and generated states, holds
  steady (no animation) in error and empty states.

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

Open `docs/design/widget-prototype.html` in a browser. All eight
states are rendered there at actual size. When making any UI
change, update both this spec and the prototype together so they
remain consistent.
