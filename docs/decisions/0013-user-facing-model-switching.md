# ADR 0013: User-facing model and provider switching

## Status

Accepted. Implementation deferred to its own future phase; this ADR captures
the decision while it's fresh and is not a commitment that the work happens
in any particular session.

## Context

Through Phase 6, the app has supported multiple providers via the
abstraction in `llm-provider.md`, but provider and model choice has been
configured once and treated as static. Users have asked to switch
providers and models per-session to manage cost — a 100-table schema
question on Opus 4.7 costs ~10x more than on Haiku 4.5, and not every
question warrants the most capable model.

The architecture was designed to make this possible (the `LlmProvider`
trait, the model registry, BYO key per provider). What's missing is the
user-facing surface and the routing logic that picks defaults
intelligently.

## Decision

Add a model picker to the main query UI, alongside the question input.
The picker shows the active provider and model, and lets the user switch
either before asking. Per-question model choice does not require leaving
the main flow.

The settings screen continues to be where API keys for each provider are
stored. Today those keys live in the SQLCipher-encrypted local store; OS
keychain migration is tracked separately under ADR 0008 and is explicitly
out of scope for this ADR. The picker reads from configured providers; if
a provider has no key, it shows as "set up in settings."

Default model selection on first use of a provider follows this order:

1. If the provider has a model marked `recommended_for: "default"` in
   the model registry, use it.
2. Otherwise the cheapest model that supports structured output.

The model registry adds a `cost_tier` field (`"low" | "mid" | "high"`)
sourced from the static JSON registry. This is displayed in the picker
so users see relative cost without us hardcoding dollar amounts that
would go stale.

Switching providers mid-session is supported. Switching models within a
provider is supported. The current schema is unaffected by either
switch — the schema slice is rebuilt for the new model's context window
on the next question.

## Rationale

- The architecture already supports this; we are exposing capability
  that exists, not building new infrastructure.
- BYO key combined with cost-tier visibility lets users self-manage
  spend without us having to track or display real-time pricing.
- Per-question switching is the right granularity: per-app-launch is
  too coarse (users will forget to switch), per-keystroke is noise.
- Defaults bias toward Sonnet rather than Opus to protect first-time
  users from surprise bills, with Opus available one click away.

## Tradeoffs accepted

- **More UI surface in the main flow.** The picker adds visual weight
  to the query screen. Mitigated by collapsing to a small label by
  default and expanding only on click.
- **Possible model-mismatch confusion.** A user might switch to Haiku,
  ask a complex question, get a worse answer, and not realize the
  cause. Mitigated by surfacing low-confidence warnings (already in
  `sql-generation.md`) and by showing the active model name on the
  generated SQL.
- **Cost-tier display is approximate.** We can't show exact costs per
  query without running token counts, which we deliberately don't do
  in real time. The tier label is a heuristic, not a quote.

## Alternatives considered

- **Auto-routing by question complexity.** Try Haiku first, escalate
  to Sonnet then Opus on validation failure or low confidence.
  Rejected for now because it adds latency (failed calls still cost
  time and money) and obscures which model produced which result.
  Worth revisiting in a follow-up ADR if user feedback shows manual
  switching is too much friction.
- **Settings-only switching.** Forces users to leave the query flow to
  change models. Rejected as too coarse for the cost-management
  motivation.
- **Show real-time cost estimates per question.** Requires running a
  tokenizer locally for each provider. Rejected for v1 due to
  complexity; revisit if users ask for it.

## Security implications

None new. Provider switching uses the existing key storage (SQLCipher
local store today, OS keychain pending ADR 0008). Schema metadata still
goes only to the user-selected provider for that specific request. No
row data path is changed.
