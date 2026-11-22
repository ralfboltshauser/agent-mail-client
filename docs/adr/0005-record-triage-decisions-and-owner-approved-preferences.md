---
status: proposed
---

# Record triage decisions and require owner approval for preferences

AMC records owner triage choices and system predictions as immutable events, with Undo
appending a retraction and forgetting providing explicit owner erasure. Current Buckets,
Sender rules and provider placement remain projections and operational records. This
preserves the evidence behind a choice after a model changes, a provider write fails or
the owner restores mail.

Preferences are versioned plain-language rules with evidence links. Agents may read and
propose within a grant. Only the owner can approve activation after replay and shadow
evaluation. Model confidence and examples can inform a suggestion. Automatic Filter
requires an approved rule and an Engine-verified safety decision.

The Engine owns the log and private reasons. Use a versioned UTF-8 JSONL export with stable
label and event references so the owner can carry their annotation history across models.
Export raw reasons only on owner opt-in. Maintain the existing send and subscription
boundaries. [ADR 0001](0001-agents-cannot-send-by-construction.md) ·
[ADR 0002](0002-agents-run-through-the-owners-harness.md)

## Considered options

- A mutable corrections table is simpler to query. It loses the original prediction,
  reason and verdict each time triage revises a result.
- Full mailbox event sourcing couples provider reconciliation and inverses to model
  history. Retain the existing writeback journal while making annotation durable.
- Updating a prompt or model directly from feedback takes less product work. Explicit
  rules give the owner inspectable approval, retirement and targeted rollback.

[Owner preferences spec](../specs/owner-preferences.md)
