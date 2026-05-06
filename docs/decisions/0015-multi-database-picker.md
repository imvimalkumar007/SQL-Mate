# ADR 0015: Multi-database picker in the widget

## Status

Accepted.

## Context

The connection_profiles infrastructure has supported multiple
connections since Phase 2, but the widget currently uses a single
active connection set in the main window. Users with more than one
database (a common pattern: prod warehouse, staging, an analytics
replica) have to leave the widget, switch connections in the main
window, and return. This breaks the widget's central value: not
leaving your IDE flow.

## Decision

Add a connection picker to the widget header, replacing the static
connection name in the context label. The picker shows the active
connection name; clicking opens a small floating menu listing all
configured connections. Selecting one switches the active connection
for the next question. The picker opens upward when the widget is in
the lower half of the screen.

Switching the active connection mid-session:
- Rebuilds the schema slice from the new connection's stored schema
- Updates the schema pill in the action row
- Marks any currently displayed SQL as stale (greyed out, "from
  previous connection" label)
- Updates the system prompt to use the new connection's dialect
- Preserves the question textarea content (the user may want to ask
  the same thing of a different database)

Connections that have a cached schema appear normally. Connections
without a cached schema appear in the picker but are flagged "no
schema yet"; selecting one prompts the user to extract its schema in
the main window before continuing.

The picker shows the schema's age in small text under the connection
name ("extracted 2 days ago"). Connections older than 7 days show a
small refresh affordance; clicking it triggers the metadata
extraction query. The widget never auto-refreshes schema.

## Rationale

- The infrastructure already exists; this exposes it.
- Switching connections is a common workflow that currently forces
  users out of the widget. Solving it inside the widget preserves
  the no-context-switch property the widget was built around.
- Showing schema age and offering manual refresh is honest about
  staleness without violating the no-auto-network-call principle.

## Tradeoffs accepted

- More UI surface in the widget header. Mitigated by collapsing the
  picker to a single line when not active.
- Possible confusion if SQL is stale after a switch. Mitigated by
  greying out and labeling the previous SQL clearly.
- Connections with stale schemas may produce wrong SQL. The refresh
  affordance and the visible age are the mitigations; the user
  remains responsible for keeping schemas current.

## Alternatives considered

- Connection switching only in the main window. Rejected for the
  workflow-friction reason above.
- Auto-detect connection based on the IDE's active database.
  Rejected. Would require reading from the IDE, which is exactly the
  kind of integration the widget avoids.
- Auto-refresh stale schemas in the background. Rejected per the
  architecture rule against unprompted network calls.

## Security implications

None new. Each connection's credentials and metadata are stored the
same way. No new network calls. Schema extraction queries are the
same metadata-only queries used in Phase 2. Per-connection redaction
rules and annotations apply unchanged.
