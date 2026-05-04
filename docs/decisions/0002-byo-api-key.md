# ADR 0002: Bring-your-own LLM API key

## Status

Accepted.

## Context

The app needs to call an LLM. Two structural options:

- **We host the LLM call.** Users authenticate with us; we proxy LLM requests through our server using our keys; we charge for usage.
- **Users bring their own LLM API key.** The app calls the LLM directly from the user's machine; we are not in the data path.

## Decision

We require users to bring their own LLM API key. We never proxy LLM calls.

## Rationale

- **Security claim integrity.** Our central differentiator is "we are not in the data path." If we proxy LLM calls, that claim is weakened: schema metadata transits our server. Even with strict no-log policies, this changes the threat model and makes enterprise security review materially harder. BYO key keeps the claim structurally true.
- **Compliance burden avoided.** A proxy makes us a data processor under GDPR, a HIPAA business associate (potentially), and subjects us to a stack of audits and DPAs. BYO key avoids all of this.
- **Aligns with the target user.** Regulated mid-market data engineers often already have enterprise LLM access (Anthropic via Bedrock, OpenAI via Azure, etc.) approved by their security team. They prefer to use that approved access rather than introduce a new vendor relationship.
- **Provider-flexibility falls out naturally.** Once users supply their own key and base URL, supporting any OpenAI-compatible endpoint is essentially free. See ADR 0003.

## Tradeoffs accepted

- **Higher onboarding friction.** Users must obtain and paste an API key. We mitigate with clear setup guidance per provider and a "Test connection" button.
- **No transparent cost capture.** We can't charge per-request. The business model has to be elsewhere — license, team features, support — not LLM markup.
- **Less control over output quality.** If a user picks a weak model or sets a tiny token limit, the experience suffers and they may blame us. Mitigated by surfacing recommended defaults in the model registry.

## Alternatives considered

- **Hybrid: BYO key default, optional hosted tier.** Rejected for v1 because operating a hosted tier requires the compliance and operational burden we're trying to avoid. May revisit after first ten paying customers if there's clear demand.
- **Free tier with our key, paid tier BYO.** Rejected because the free-tier path violates the "not in the data path" claim, and we don't want a two-tier security story.
