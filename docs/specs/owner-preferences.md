# Owner preferences

Status: proposed · Baseline: main at `9f1e6c2` ·
[Decision record](../adr/0005-record-triage-decisions-and-owner-approved-preferences.md)

## Problem

Triage is the moment the owner can cheaply say what matters and why. AMC should retain that
judgment even when a prediction changes, a provider move fails, or the model changes.
The first use is **Filtered**, a recoverable place for mail the owner chooses to omit from Inbox.
An incorrect automatic move can hide a security alert, bill or obligation. Leaving an optional
update in Inbox costs a review. That asymmetry governs rollout.

| Shipped behavior | Consequence for this design |
| --- | --- |
| [Migration 21](../../apps/engine/src/db/migrations.ts) stores `owner_action`, current `sender_rule`, `owner_handled`, and `screening_work`. [Sender actions](../../apps/engine/src/mail/senders/actions.ts) record prior rules and revisions. Undo can restore a rule and separately reverse provider work. | Retain current Account-local Sender rules and the work journal. Capture the owner's choice separately from its provider outcome. |
| [Migration 22](../../apps/engine/src/mail/triage/migration.ts) stores corrections with previous assignment, copied subject/snippet and mutable undo status. [Corrections](../../apps/engine/src/mail/triage/corrections.ts) mark the current arrival handled and return twelve recent Account examples. Plain owner Bucket writes can mark handled without creating a correction. | Backfill known facts, cover both owner paths going forward, and retire copied content from the learning path. |
| [Triage input](../../apps/engine/src/mail/triage/input.ts) selects the latest eligible Inbox message. [Model writes](../../apps/engine/src/mail/triage/model.ts) fence using the active lease, Thread modseq and handled watermark. | Label a particular arrival. Use modseq as a concurrency fence. A read flag or Bucket change can advance it without creating new mail. |
| [MCP](../../apps/engine/src/mcp/server.ts), the [CLI runner](../../apps/cli/src/triage.ts), and its [prompt](../../apps/cli/prompts/triage.md) classify unassigned Threads under a short Account grant. The Harness sees a batch-limited read forwarder. | Keep that read boundary. Extend runner submission explicitly. Bind provenance to a validated run and record predictions even when the Engine declines to apply them. |
| [Destination handling](../../apps/engine/src/mail/senders/destination.ts), [Organise](../../apps/engine/src/mail/mutations.ts) and [exact UID writes](../../apps/engine/src/providers/imap/organise.ts) already handle Screened out and verification. [Notifications](../../apps/desktop/src/main/notifications.ts) look at per-message screening disposition. | Reuse verified writeback and recovery for Filtered. Keep destination identities and notification semantics explicit. |

[Smart Inbox](smart-inbox.md) and [tracking issue #154](https://github.com/ralfboltshauser/agent-mail-client/issues/154)
set the integration boundary. [Superhuman research](../research/superhuman-vs-amc.md) and
[#158](https://github.com/ralfboltshauser/agent-mail-client/issues/158) motivate previewing affected mail.
[#160](https://github.com/ralfboltshauser/agent-mail-client/issues/160) motivates later draft provenance.
[#156](https://github.com/ralfboltshauser/agent-mail-client/issues/156) and
[#162](https://github.com/ralfboltshauser/agent-mail-client/issues/162) inform keyboard verification and synthetic practice.
[#157](https://github.com/ralfboltshauser/agent-mail-client/issues/157),
[#159](https://github.com/ralfboltshauser/agent-mail-client/issues/159),
[#161](https://github.com/ralfboltshauser/agent-mail-client/issues/161),
[#163](https://github.com/ralfboltshauser/agent-mail-client/issues/163),
[#164](https://github.com/ralfboltshauser/agent-mail-client/issues/164) and
[#165](https://github.com/ralfboltshauser/agent-mail-client/issues/165) remain independent ideas.
[#170](https://github.com/ralfboltshauser/agent-mail-client/issues/170) illustrates why a From string,
logo or unverified header is insufficient authentication evidence.

## Language and taxonomy

Use [the glossary](../../GLOSSARY.md). A **Triage decision** is an explicit owner judgment,
a **Triage prediction** is a system assessment, and the **Decision log** retains both.
A **Decision label** belongs to one taxonomy axis. A **Preference rule** is an owner-editable
plain-language instruction in a versioned **Preference policy**.

| Axis | Stable decision labels | Scope |
| --- | --- | --- |
| Filter | `filter.filtered`, `filter.keep` | One incoming message. Filtered is the displayed AMC Label. Restore means Keep in Inbox. |
| Bucket | `bucket.reply`, `bucket.action`, `bucket.follow_up`, `bucket.update`, `bucket.later`, `bucket.when_i_have_time`, `bucket.newsletters`, `bucket.clear` | Thread judgment against its current incoming message when one exists. Map the existing protocol's Bucket names at the boundary. |
| Sender | `sender.accept`, `sender.block`, `sender.clear` | Normalized full Sender within one Account. Clear removes the explicit rule. Block uses Screened out. |
| Attention, reserved | `attention.interrupt`, `attention.quiet` | One incoming message. Record no new attention decisions until [#10](https://github.com/ralfboltshauser/agent-mail-client/issues/10) defines that product contract. |

Registry is a checked-in map keyed by axis and stable ID, starting at taxonomy v1.
Write and export the taxonomy version on each event. Display names may change independently.
Additive labels increment the registry version. A semantic change gets a new ID, with the
old ID readable while its events are retained and an explicit compatibility map wherever a consumer needs one.
Unknown future labels can be displayed by ID or skipped by a projection. They cannot execute.
Clear is an explicit choice. Undo targets a previous event rather than emitting Clear.

A stable subject key is scoped to Account, mailbox generation and axis. Filter uses the
incoming message key. Bucket uses Thread plus incoming message key (Thread-only for owner
writes outside Inbox when no eligible arrival is available). Sender uses the Account-scoped
sender hash. Keep local Thread and message IDs for navigation and exact writes. Gmail uses
Account-qualified provider message identity. IMAP uses the Engine's verified rebind lineage
to preserve the arrival key across a verified move or restore. The fingerprint is a lookup
hint. An ambiguous fingerprint starts no automatic move and attaches no inferred history.
On Account rebind or mailbox identity reset, bump generation and suspend old pending work.
History remains attributable to its original generation.

## Decision log and projections

Store append-only facts in Engine SQLite. A prediction records an assessment, an owner event
records intent, and Organise journals whether delivery state changed. The event and any local
projection or queue insertion commit in one transaction. Provider acknowledgments arrive
asynchronously. Failed or partial writeback still leaves an explicit owner judgment.
Historical evidence and current state can disagree legitimately.

### DDL sketch

SQLite types shown here define the contract. Encode JSON with versioned strict protocol
schemas, check event-kind invariants in the append service and schema, and avoid cascade
updates or deletes from replica, action, mutation or token tables into the log. Target and
prediction links are validated on append. They remain opaque when the referenced event is
forgotten so dependent events can remain immutable.

```sql
CREATE TABLE triage_event (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  account_id TEXT NOT NULL,
  account_generation INTEGER NOT NULL,
  axis TEXT NOT NULL,
  subject_key TEXT NOT NULL,
  thread_id TEXT,
  message_id TEXT,
  arrival_key TEXT,
  input_revision INTEGER,
  kind TEXT NOT NULL CHECK (kind IN
    ('prediction','decision','undo','reason_revised','review_observed')),
  source TEXT NOT NULL,
  taxonomy_version INTEGER NOT NULL,
  label_id TEXT,
  created_at INTEGER NOT NULL,
  action_id TEXT,
  run_id TEXT,
  target_event_id TEXT,
  prediction_id TEXT,
  confidence TEXT CHECK (confidence IN ('low','medium','high')),
  policy_version_id TEXT,
  matched_rule_revision_id TEXT,
  harness_id TEXT,
  model_id TEXT,
  adapter_version TEXT,
  prompt_version TEXT,
  features_json TEXT NOT NULL CHECK (json_valid(features_json)),
  detail_json TEXT NOT NULL CHECK (json_valid(detail_json)),
  dedupe_key TEXT NOT NULL UNIQUE
) STRICT;

-- Content-bearing data is separately erasable. One row per event at most.
CREATE TABLE triage_owner_reason (
  event_id TEXT PRIMARY KEY REFERENCES triage_event(id),
  reason TEXT NOT NULL CHECK (length(reason) BETWEEN 1 AND 500)
) STRICT;

CREATE INDEX triage_subject ON triage_event
  (account_id, account_generation, axis, subject_key, seq DESC);
CREATE INDEX triage_replay ON triage_event (account_id, kind, created_at, seq);
CREATE INDEX triage_action ON triage_event (action_id);
CREATE INDEX triage_target ON triage_event (target_event_id);
CREATE INDEX triage_prediction_reference ON triage_event (prediction_id);
```

| Kind | Fields and invariants |
| --- | --- |
| `prediction` | Label (nullable for abstention), confidence, policy version, matched rule revision or explicit no-match in detail, Harness/model ID, prompt version, run ID, input fence and features. Detail records mode (`live` / `shadow`), stage and typed protection outcomes. Allow explicit unknown provenance only for legacy or an unreported model. A prediction alone confers zero authority. |
| `decision` | Label, source (`triage_key`, `thread_action`, `restore_filtered`, `sender_review`, `cli`, `legacy`), action ID, optional separate owner reason, features and optional immutable prediction reference. Store the pointer in SQLite and join the original snapshot for owner read/export. Prefer the prediction explicitly displayed and validated for the same input. Restore instead links to the exact acknowledged automatic move through its work journal. With neither link, leave it null. |
| `undo` | Target decision ID, or original prediction ID for owner reversal of an automatic move. Record requested operation separately from provider status. Append only after the Engine accepts an Undo intent. Rejected or stale requests do not remove evidence. Accepted Undo retracts the targeted judgment where it exists. An Undo of an automatic move is recovery evidence. Restore is the explicit Keep judgment. |
| `reason_revised` | Target decision ID, new reason in the separate table, or explicit null to clear the displayed reason. Retain earlier event versions until forgotten. A later reason edit cannot change a label, stale action or provider effect. |
| `review_observed` | Phase 5. Target prediction and review session, source `filtered_review`. Acknowledged exposure with no explicit disposition is a weak signal. No reason and no owner label. |

Use Engine timestamps and `seq` for ties. An owner action and exact subject identify a
decision, Undo is unique per target/action, and reason edits dedupe by edit UUID. Runner
predictions dedupe by run, input and axis. Exact retry returns the previous receipt.
Changed payload under the same key is a conflict, including reason changes. Keep any
request fingerprint keyed and private, alongside erasable reasons. Use versioned event
payloads and canonical serialization. A read context fence captures mailbox generation
and message identity as well as modseq. Shadow results cannot be promoted in place.

Freeze an allowlisted feature snapshot at observation. Historical backfill explicitly marks
features read later or unknown.

| Feature | Representation |
| --- | --- |
| Sender | HMAC-SHA-256 of normalized full mailbox scoped to Account and generation with an Engine-only key and key version. Null for ambiguous or missing From. Keep normalized domain separately. A hash is pseudonymous data. |
| List-Id | Validated bounded canonical identifier, stripped of display text, or null. Treat it as untrusted and potentially identifying. |
| List-Unsubscribe | Nullable boolean (unknown, absent, present) plus optional one-click presence when already available. Do not copy URLs, mailto values or credentials. |
| Provider category | Allowlisted Gmail category IDs normalized without Account prefix, or null. Never infer IMAP category from a folder name. |

[Gmail mapping](../../apps/engine/src/providers/gmail/mapping.ts) and
[IMAP mapping](../../apps/engine/src/providers/imap/mapping.ts) already extract
List-Unsubscribe for the mail replica. Add List-Id extraction in the same ingest path,
using the [store](../../apps/engine/src/mail/store.ts) for normalized persistence.
Unknown headers, unavailable classifications and malformed values stay unknown.
No copied subjects/snippets, attachment references or model free-text rationale in the log.
Existing Bucket display reasons can still use their bounded assignment field.

### Read models and writeback

- Use a SQL view/query over valid events initially. Current examples resolve the most recent
  unretracted owner label per subject in the requested axis, with the latest reason revision.
  Undoing a newer choice exposes the previous eligible judgment. Retracting an older choice
  leaves later choices intact. Policy approval records exact supporting decision IDs and exact
  reason revision IDs when used.
- Keep `sender_rule`, Thread Bucket, `owner_handled`, and verified provider labels/locations
  as operational projections. Replay of the Decision log orders facts for learning and
  evaluation. Replay issues zero provider mutations. Provider changes can alter current
  placement without rewriting what the owner chose.
- Keep `owner_action`, `screening_work`, and `mutation` for operational status and inverses.
  Link accepted requests using IDs. A later auto execution links the work request to the
  original prediction with a unique prediction/message key, never the inverse. Use one
  provider work child per exact target. Filtered and Screened out have separate managed
  destinations. Existing generic Agent Organise restrictions cover both directions for both.
- Owner F/Restore annotates each captured eligible message. A reason for a deliberate batch
  applies to those captured messages. Use a single primary reason event for the batch and an
  explicit reference from siblings, so it has one physical copy and can be erased coherently.
  Restore records Keep even when no automation caused the move. Bind false-positive
  attribution to a verified automatic placement for that exact message and generation.
- Gmail must verify add-Filtered and remove-Inbox, preserving unrelated labels. IMAP must
  verify the exact source and destination identities using the existing safe move and inverse.
  Recheck current generation, membership, approval and protection before dispatch. On
  failure leave a recoverable Inbox or journal-backed repair path. A provider-side move is
  placement evidence only. It neither manufactures owner annotation nor authorizes another move.

## Preference policy

One active version per Account for v1. A version is an immutable ordered list of rule revisions.
Each rule has a stable ID and immutable revisions. A revision includes axis, effect, text,
exceptions, enabled threshold and supporting events. Edits create a proposed version.
Owner-created rules can have zero evidence and explicit `owner_authored` provenance.
A proposal based on data cites the exact examples and any contradictions shown during review.
Keep rules bounded (20 per Account, 500 characters of text and 500 of exceptions per rule).
List order is owner-controlled. A conflict between applicable effects falls back to Inbox
with a conflict review reason, even if one rule has higher priority.

| Table | Columns and constraints |
| --- | --- |
| `preference_policy_version` | `id, account_id, account_generation, parent_id, created_at, proposed_by_kind, proposer_ref, taxonomy_version`. Immutable content. |
| `preference_rule_revision` | `id, rule_id, account_id, axis, label_id, text, exceptions, min_confidence, created_at`. Minimum automatic Filter threshold is high. |
| `preference_policy_rule` | `version_id, ordinal, rule_revision_id`. Unique ordinal and rule within a version, same Account only. |
| `preference_rule_evidence` | `rule_revision_id, decision_event_id, reason_event_id?, relation` (supports/contradicts). Same Account and generation. |
| `preference_policy_transition` | `seq, version_id, from_state, to_state, owner_action_id, at, evaluation_id?`. Owner-only CAS for transitions. |
| `preference_active` | `account_id, account_generation, version_id, activation_id`. Transactional single active pointer. |

Lifecycle: **proposed → shadow → active → retired**. An owner starts shadow or retires a
version. Evaluation qualifies a shadow version for owner activation. Activation atomically
retires the previous active version and checks the expected active pointer, candidate hash,
policy and pipeline versions, and evaluation validity. Rollback retires immediately and
returns to suggestions or reactivates a reviewed copy through the same gate.
An Agent may read permitted policy text and propose candidate rules using scoped MCP.
Only the owner can accept or activate through owner HTTP. Desktop and paired CLI use the
shared owner check in [sender actions](../../apps/engine/src/mail/senders/actions.ts).
Confined Harnesses never receive paired owner credentials. Preserve ADR 0003's Host caveat
for external processes. A proposal, model verdict, or output that names a rule never grants
rights. This design adds no Agent Send ability under [ADR 0001](../adr/0001-agents-cannot-send-by-construction.md).

## Classification

The Engine resolves eligible input and policy, builds a context receipt, and owns every
writeback decision. The runner drives the installed subscription Harness and maps structured
output into predictions. Return protection assessment and each axis independently.
For a policy-based prediction return the matching rule revision (or explicit no-match).
Validate the citation against the exact Account, axis and version served with the context.
Persist a typed reason for deterministic decisions, conflicts and abstentions. Model
confidence is ordinal and earns no assumed probability.

| Order | Resolution |
| --- | --- |
| 1. Owner state | Use current exact Sender rule. Block follows the existing explicit Screened out path. Accept always vetoes automatic Filter, including without outbound history. Clear falls through. An explicit owner decision on the exact arrival wins on its axis. |
| 2. Hard protection | Engine veto of automatic Filter for security/account access or recovery, billing/payment, Interrupt candidates, provider Important, and uncertain or incomplete safety evidence. Use structured current-message protection assessment plus independent local checks, including bounded metadata/preview indicators. Sender-known status, list headers and model confidence cannot override a veto. |
| 3. Active policy | Evaluate the pinned version and ordered applicable rules. Agreeing rules cite the first applicable revision. Conflicts, unsupported citations, missing material context or unknown producer stay in Inbox. Active rules can recommend Keep or Filter. |
| 4. Retrieved examples | Feed a small Account-local set as preferences evidence. Use it to suggest placement or Bucket when no active rule applies. Example-only Filter is suggestion-only. |
| 5. Default | Leave in Inbox, with existing Bucket behavior where appropriate. Abstain if required context is missing. |

Block is an explicit owner authority and retains its present behavior. For classifier
automation, only an approved Filter rule passing evaluation, its per-rule threshold,
the Account enable switch and the Engine veto can enqueue a move. Require a recent
arrival (at most 24h), one eligible incoming message in Inbox for that Thread, verified
stable identity and destination capability, no prior automatic move for the arrival,
no owner handling or outstanding action, and no partial safety context. Recheck
active version and approval at dispatch. If the Account is disabled or a newer version
wins a race, cancel pending work and reconcile any in-flight acknowledgement.
No retrospective moves. Treat a pending automatic move as reachable Inbox mail.
Keep existing notification timing and Mute checks. Do not delay notifications to wait
for triage. Only verified Filtered membership changes future Inbox notification eligibility.

Shadow runs the same rules and protection against live inputs with no mailbox, watermark
or notification writes. A separate candidate result can coexist with the live prediction.
Both reference the exact policy and prompt version evaluated. Offline replay uses the same
decision interface with an isolated result sink and zero production mutations.

### Example retrieval and prompt budget

Use indexed matching on same sender hash, List-Id, then domain, and source recency.
Rank with weights 8/4/2 for exact matches, multiply by a 60-day half-life, and break ties
by sequence. Category can be a final tie-breaker. Exclude the input itself, future events
during historical replay, retracted/forgotten events, obsolete mailbox generations,
and non-owner predictions. Prefer both labels when available. Sender judgments teach
the Sender axis. They are separate from per-message Keep/Filter training. For v1 take
up to four per target and twelve per batch, dedupe IDs, and cap serialized examples at
3 KiB across the batch. Stable target-to-example IDs prevent unrelated recent decisions
from becoming instructions. A zero-match input can still be classified with current
policy and current-message context. No embeddings.

Replace global copied-content examples in [MCP](../../apps/engine/src/mcp/server.ts)
and [CLI prompt assembly](../../apps/cli/src/triage.ts). Use features, label, and owner-approved
preference text. Keep raw owner reasons local by default. The owner can explicitly include
selected reasons in an interactive proposal run. Treat them as quoted data and show the
selection before dispatch. Never pull full source example messages into the prompt.
For a current target the existing allowlisted read forwarder may fetch bounded relevant
mail under the already authorized scope. Prefer envelope and snippet, fetch more only
when needed, and abstain from automatic Filter if required context remains unavailable.
Mail, reason examples and proposal text enter as delimited data. Engine authorization,
schema validation and local validation govern effects. [Harness ADR 0002](../adr/0002-agents-run-through-the-owners-harness.md)
and [runner confinement ADR 0004](../adr/0004-confine-the-agent-runner-on-the-host.md) apply
to proposal, replay and live inference. Use existing logged-in subscriptions with no
API-key fallback. Harness inference can process explicitly supplied inputs remotely.

## Evaluation and activation

Use one unit throughout: Account generation × incoming message × axis. Store per-rule,
policy/model/prompt and writeback cohorts. Every metric returns counts and coverage.

| Measure | Definition |
| --- | --- |
| Live restore rate | Acknowledged automatic Filter placements explicitly restored or reversed within seven days, divided by acknowledged placements with a full seven-day observation window. Attribute each restore once to the originating prediction/rule, even after a subsequent reclassification. Separate explicit Keep, reversal and provider-only restore. |
| Live assessed precision | Explicit Filter confirmations divided by explicit Filter confirmations plus explicit Keep/restores or owner reversals of an acknowledged auto placement. Show assessed sample size and percentage of acknowledged placements assessed. Publish the restore rate alongside it because review sampling is biased. Silence cannot make precision 100%. |
| Inbox misses | Explicit F for an eligible Inbox arrival where a same-input prediction kept or abstained and no auto Filter landed. Report separately unscored arrivals, owner-only filters, engine-vetoed suggestions and provider failures. A secondary assessed miss fraction divides eligible misses by assessed positives. Unknown full-mail recall remains unknown. |
| Shadow/replay | Compare Keep/Filter labels against owner's final explicit judgment per arrival. Show would-move, would-keep, abstained, protected, unscored, false positives and misses per rule. Compare candidate against current policy on the same inputs and show affected IDs in owner review. |
| Regression | Pinned owner-labeled positive and negative examples and synthetic hard-protection cases, frozen by IDs in a manifest. Keep held-out data out of retrieval and policy support. Re-run on policy, model, prompt, guard, retrieval or taxonomy-behavior changes. |

Default to the past 30 days, owner-adjustable 7–90 days, cap 200 eligible labelled
arrivals per Account per replay. Use stored non-content features first. Where content
is essential, join only the original still-available input via a scoped read, never a
newer message or a replacement subject/snippet. Report absent/ambiguous inputs as
unscored. Evaluate against a held-out chronological slice grouped by Thread so an
example and its reply cannot appear on both sides. Exclude policy support, pinned
regressions and near-duplicate arrival IDs from held-out scores. Preserve training
cutoff, sampled IDs, version and coverage with the result. Report any leakage as
invalid evaluation. For previews show proposed moves and mismatches with links in
the owner's Client, no mail content in diagnostic logs. Bucket and Interrupt preview
can use the same replay seam once their policy axes are enabled ([#158](https://github.com/ralfboltshauser/agent-mail-client/issues/158)).

For v1 gate each automatic rule on replay plus live shadow totaling **at least 30
distinct held-out owner-assessed would-move arrivals**, zero explicit Keep disagreements
among them, no hard-protection misses and a passing regression set. Require at least seven
days of shadow and at least one explicit live-shadow positive for the exact version tuple.
Use shadow cards for explicit assessment without moving mail. This bar limits pilot scope.
Even 30/30 is compatible with an error rate near 10% at a one-sided 95% bound. Treat it as
minimum evidence and cap rollout to five auto moves per Account per day. Use a tracked
review backlog and pause automation if its oldest unreviewed item exceeds seven days,
or on the first attributed explicit Keep/owner reversal for the rule. Keep suggestions
available. Renew activation with a new shadow evaluation after model/prompt changes,
guard changes, policy edits or evidence deletion. If the Harness cannot report a model ID
or configuration is no longer current, serve suggestions only. Record observed model IDs
and adapter/config version. A rolling provider alias still carries residual model drift.

## Annotation and review UX

| Surface | Interaction |
| --- | --- |
| Thread list and reader | ! (Shift+1) applies Filter out. F opens Forward. The Thread toolbar and list context menu offer Filter out and Restore to Inbox where applicable. |
| Triage | F applies Filter out to the displayed eligible Inbox selection. Shift+F opens an optional reason field. X blocks the exact Sender. Shift+X opens an optional reason there. Plain shortcuts bypass reason entry. Escape cancels; Enter commits from the reason editor; retain draft on recoverable submission failure. Keyboard commands do not send. |
| Filtered | Show exact move source and linked rule or manual choice, pending/partial status, Restore to Inbox and Undo where available. Old rows without evidence show unknown origin. Restore can optionally carry a reason. Bulk operations show captured scope and acknowledge per-message outcomes. Keep the Inbox accessible from the view. |
| Reasons | Ask inline only when opening a deliberate reason shortcut, or offer a dismissible reason prompt on the first conflict or low-confidence override per session. Same input never nags again. Patch reason through a versioned owner event. Default Enter on the regular decision stays fast. |
| Queue | Preserve New Sender cards first during the Phase 1 rollout. Later prioritize policy conflicts and uncertain high-impact arrivals, then novel patterns (new List-Id/domain or unsupported rule), then older low-confidence cards. Cap at 20 prioritised Thread cards per session, stable ordering by tier, arrival and ID. Keep the existing snapshot cursor, exact revision and resume contract in [queue](../../apps/engine/src/mail/triage/queue.ts). |
| Daily Filtered review | Present recent automatic moves in a pull-based daily review. Explicit confirmation records Filter. Restore records Keep. Closing a review after the owner actually opened an item with no action gives at most one weak observation per placement, weight **0.1** versus an explicit judgment at **1.0**. View counts and untouched mail carry zero weight. Weak evidence only influences ranking, never activation, metrics of explicit accuracy or regression labels. |
| Drift | Recency boosts example selection. Mark a rule stale when it has no recent explicit supports for 90 days or new contradictions. Show one “Still true?” owner review card per stale rule and pause automatic Filter pending review. A rollback or contradiction never creates a hidden counter-rule. |

Reuse the [triage review](../../apps/desktop/src/renderer/src/features/triage-review/triage-review.tsx)
and [sidebar](../../apps/desktop/src/renderer/src/components/app-sidebar.tsx).
The owner can advance on durable acceptance while work remains pending, with visible status
and Undo across restarts. Restrict rich private reasons to owner-authorized views. Do not
persist reasons in renderer history or replica snapshots. Clear transient input once the
Engine acknowledges durability.

## Module and surface contracts

| Boundary | Contract and integration |
| --- | --- |
| Decision log | `appendPrediction(context, result)`, `appendDecision(owner, capture)`, `appendUndo(owner, target)`, `reviseReason(owner, target, expectedHead, editId)`, `readEffective(criteria)`. Implement in `mail/triage/annotations.ts` with a feature extractor. Integrate v21 actions and v22 corrections through their existing transactions. |
| Prediction and context | `prepareContext(account, lease, inputs)` yields versioned receipt, exact input refs, policy and example payload. `submitPrediction(lease, receipt, runId, input, outputs, producer)` persists validated predictions and returns projection outcome. Extend [model.ts](../../apps/engine/src/mail/triage/model.ts); keep projection and provider routing at the Engine. Capture adapter/config/model/prompt versions outside model output. |
| Execution | `evaluateFilterEligibility(predictionId, input)` returns a typed denial or permit. `enqueueFilter(permit)` and dispatch revalidate through [mutations](../../apps/engine/src/mail/mutations.ts). On Phase 1, automatic execution always denies with `suggestion_only`. Explicit owner moves still use owner action and existing provider inverse. |
| Policy and evaluation | `getPolicySnapshot(account, mode)`, `propose(scope, proposal)`, `transition(owner, expectedVersion, evaluation)`, `evaluate(snapshot, frozenInputs)`. Separate modules when these phases land. Simulation uses the same policy input and returns outcomes with no work-queue adapter. |
| Owner HTTP | Phase 1 `GET /v1/filtered`, `GET /v1/filtered/inbox-target` for the current eligible message IDs and Thread revision, `POST /v1/filtered/decisions`, existing `GET /v1/owner-actions/:id` and `POST .../undo`. `PUT .../reason` takes edit UUID, expected reason revision (nullable) and reason (nullable). Later `/v1/preferences` for list/propose/version actions and replay. Owner-only `/v1/triage/events` for paged history, export and forgetting. |
| Broker MCP | Add lease-only `submit_triage_prediction`; `list_untriaged` returns optional `decisionLogVersion: 1`, receipt, exact arrival and revision alongside compatible fields. CLI uses new tool only when advertised. Existing `set_bucket` continues Bucket-only. Neither submit nor policy tools are forwarded to the model. Dry-run stays read-only and writes no production events. |
| Agent MCP | Later `get_preference_policy` and `propose_preference_policy` behind explicit Account-level preference read/propose grants, registered and enforced by [MCP](../../apps/engine/src/mcp/server.ts) and [scope registry](../../packages/protocol/src/scopes.ts). Thread-only grants receive no Account policy or other Thread evidence. Proposals validate cited IDs without returning raw reasons. No Activate, Erase, Export, Restore, sender-rule apply or generic managed-destination Organise tools. |
| CLI | Extend [smart-inbox.ts](../../apps/cli/src/smart-inbox.ts) with `amc triage filter`, `amc triage restore`, and `amc triage filtered`; keep `amc senders`. Read optional reason from stdin or a file to avoid shell history. Paired-owner-only `amc preferences show/replay/activate/retire`, `amc triage export/forget` in later phases. Generic status and JSON do not print reasons by default. |

Phase 1 filter HTTP input is `{threadId, decision: "filter.filtered" | "filter.keep",
expectedRevision, clientActionId, reason?, source?}` plus optional exact message selection
when a view offers it. With no selection, resolve the captured Thread action under the
revision fence and return accepted targets with the receipt. Never accept features or model
confidence from the owner API. Sender and Bucket HTTP retain current labels and project
to stable IDs server-side. Add optional `ownerReason` to owner Bucket review and manual
intent, keeping compatibility with existing required Bucket display `reason`. Legacy
default copy such as “Owner triage review” is a display explanation only.

### Runner protocol v1

The Engine binds each receipt to the live lease holder, Account generation, allowed
arrival keys, Thread revisions, mode and policy version. Give the receipt the lease
lifetime or less. An opaque, authenticated context token can carry those fields in
Phase 1. Reuse the receipt ID as run ID on retries, and require a fresh receipt for
a new run. Restrict the handoff to the broker in the existing desktop/CLI worker.
The model reads the same target list via the current forwarder. It fills only the
output fields. It cannot set input identity, version, mode or authority.

```text
submit_triage_prediction {
  receipt, runId,
  input: { threadId, messageId, arrivalKey, inputRevision },
  producer: { harnessId, modelId, adapterVersion, promptVersion },
  outputs: {
    bucket: { labelId, confidence, matchedRuleRevisionId, displayReason } | null,
    filter: { labelId, confidence, matchedRuleRevisionId } | null,
    protection: "routine" | "security" | "account" | "billing" | "interrupt" | "uncertain"
  }
}

receipt response {
  runId,
  outcomes: [{ axis, eventId, projection: "applied" | "suggested" | "stale" | "shadow" }]
}
```

Null is abstention on a requested axis. Omit disabled axes entirely.
The prompt version fingerprints the template, response schema and context builder,
excluding mail and private reasons. Record selected example event IDs in detail, not
their contents. The broker uses Harness-reported model identity where available.
Configure allowed producer versions at the Engine before automatic execution.
A stale but authorized submission from an unexpired receipt can record a prediction
against its original input with a stale outcome. Never rebase it onto newer mail.
Expired, unauthorized, mismatched or malformed receipts cannot append. If a filter
suggestion and Bucket prediction land together, commit one transaction and leave
the Bucket visible on the Inbox Thread. Filter eligibility can distinguish that
same-run Bucket from a later owner or other writer, so the Bucket does not silently
disable the Filter axis. A later arrival clears stale suggestion state.

### Intent, outcome and recovery examples

| Invented scenario | Facts and current state |
| --- | --- |
| AMC suggests filtering an optional club digest. The owner presses Shift+F and writes “I use the monthly edition.” The provider declines the move. | The prediction survives. The owner event and private reason survive as explicit judgment even while the message stays in Inbox. Read the failed status from the work journal. This is neither an auto-filter placement nor a miss. |
| An approved rule moves one optional digest. The owner finds that this edition contains a bill and restores it. | The verified move references the prediction. Restore appends Keep with that exact reference and optional reason. The per-rule outcome records a false positive once. The Inbox return and pause use the exact message and rule versions. |
| A Thread receives an event invitation after an older digest was predicted Filtered. | The newer arrival differs from the context receipt. The stale prediction is historical evidence. The Engine leaves the newer arrival in Inbox. Mixed-message automatic moves are ineligible. |
| An owner blocks a Sender and later edits why. An Agent proposes a more general rule. | The exact Sender block and its provider journal remain active. A reason edit adds a revision. A broader policy proposal has no effect until the owner approves its own separately evaluated version. |
| The owner undoes a recent Bucket correction after another Client has changed the Bucket. | The existing revision check determines operational application. A rejected stale Undo does not change training. An accepted retraction explicitly shown to the owner may retract its evidence without overwriting the newer Bucket. |

## Migration, privacy and portability

1. Ship additive migration after 22, choosing the next number on rebase. Preserve legacy
   operational records, revisions and undo behavior. Introduce the log and dual capture
   for owner actions and new predictions immediately. For historical events use deterministic
   IDs per Account/action/subject; import idempotently from a captured cutoff in bounded
   restartable batches, and expose completeness. Sequence rules for backfill order by legacy
   owner timestamp with deterministic action/revision ties. Effective chronology uses known
   legacy action order, with live capture taking precedence over imported history for collisions.
2. Import v22 review choices and v21 owner Bucket manual action requests where the label
   can be decoded. Use exact previous metadata only where present. When a manual action
   did not retain arrival identity, retain it as historical Thread-only and exclude it from
   arrival-level examples and replay. Never guess historical confidence, policy, prediction,
   generation or owner reason. Legacy system Bucket fields are mutable state and cannot
   reconstruct a prediction. Copy current effects only as operational data.
3. Import v21 Sender decisions, clears and effective restores using Action requests and
   current rule revision provenance. Where an old restore cannot be joined unambiguously
   to its Undo request, keep it as a separate legacy transition with unknown target. Import
   accepted legacy Undo with available disposition. Preserve ambiguous/superseded attempts
   in operational history and exclude them from inference. Keep orphaned or undecodable
   rows accessible in existing history, count them in migration status and never fabricate facts.
4. Stop creating correction summaries with copied mail content. Preserve existing summaries
   as legacy operational data during the bridge, excluded from new retrieval, exports and
   prompts. Preserve existing inverse fields and v21 work rows. Audit counts and representative
   projections before retiring the correction example reader. In a later migration remove
   duplicate summaries once the rollback window closes and verify surviving owner labels and
   Undo. Keep v21 Sender rules authoritative for exact matches.
5. Raw owner reasons are Engine-owned private data. The separate reason store and approved
   private policy text stay in Engine SQLite and owner-controlled backups. Restrict both
   to the Engine identity. Require encrypted storage for off-Host backup copies. The
   existing [SQLite backup path](../../apps/engine/src/db/backups.ts) writes database files. Never
   log reasons, prompt bodies, raw requests, model transcripts, or export bytes to telemetry,
   errors, Agent action audit, renderer caches or CLI progress. Engine backups and local
   owner export are explicit data copies. Keep opaque references and aggregates in diagnostics.
6. Export UTF-8 JSONL. A manifest row declares `format: "amc.owner-preferences"`,
   `version: 1`, creation time, taxonomy versions and scope. Record kinds are
   `event`, `policy_version`, `rule_revision`, `rule_evidence`, `policy_transition`.
   Sort events by Engine sequence and include stable source IDs, event links, label IDs,
   ISO UTC timestamps, allowlisted feature snapshots and resolved prediction snapshots.
   Remap local mail and Account IDs to opaque export references consistently within a file.
   HMAC keys and raw addresses stay on the Engine. Include reason text only on explicit
   owner opt-in. Exported domain/List-Id and policy text may identify the owner's interests.
   Mark unavailable/redacted provenance explicitly. Use an owner-selected output file with
   restrictive permissions and no overwrite. Define portability now and defer an importer.
7. **Forget** is the explicit owner-authorized exception to append-only. Use a fenced
   transaction to erase the requested private payload and event, clear linked provenance
   from read projections, remove reason revisions attached to the erased decision, purge
   derived examples, replay caches, exports staged on Engine, and retire any active version
   that copied or depended on that reason/evidence. If a reason is shared by a batch, redact
   the one physical payload for every sibling. If an event is referenced, retain only an
   opaque deletion tombstone outside the log to stop reimport; omit the deleted payload
   and joined references from reads and exports. Remove linked learning copies in legacy
   records without erasing required provider journal state. Purge dependent policy text
   revisions if they may contain that payload. Account deletion erases its learning scope.
   Quiesce affected runs and expire policy/evaluation receipts. Forgetting leaves current
   mailbox placement and explicit Sender rules intact unless the owner separately reverses
   them. Use existing backup retention plus a restore-time erase ledger stored under owner
   control outside the rolled-back backup set. Reapply it before restored data can serve
   requests. Disclose that older snapshots retain deleted bytes until aged out or removed. SQLite purge must cover WAL/checkpoints and
   controlled vacuum. Prior owner exports and Harness processing are outside Engine erasure.

### Phase 2 operations

- Use **Settings → Privacy** to save a JSONL export or open Action history. Load private
  history to view reasons and edit or forget a decision. CLI equivalents are
  `amc triage history`, `amc triage export --output <new-file>` and
  `amc triage forget <event-id> --confirm`. Use `--include-reasons` for an explicit opt-in.
  Exports group shared reasons by their per-file action reference and contain only the
  event record types available in this phase.
- The bridge captures its source rows in migration 24 and commits bounded batches while
  the Engine serves. History and the manifest report migration progress. Legacy records
  without provable mailbox generation or arrival identity remain historical evidence,
  with an unknown generation. Current Bucket and Sender state, revision fences, and
  inverses stay with their existing operational stores.
- Keep the Engine-owned, mode-0600 `owner-erasure.sqlite` beside the live database, outside
  the nightly and pre-migration snapshot sets. Back it up separately and retain its latest
  state when replacing an older database. Use `amc-engine restore <file>` so the Engine
  applies the current erase ledger to the staged copy before publishing it. The Engine
  refuses a missing or mismatched ledger when the current database or backup identifies
  it. For a restore onto a new machine from a pre-v24 snapshot, restore the latest ledger
  alongside it first. Those earlier snapshots cannot identify the ledger themselves.
- Forget purges live SQLite pages and the WAL. Nightly snapshots retain erased bytes
  according to the existing retention of 14 daily and eight older weekly copies.
  Pre-migration copies, pre-restore copies and manually retained snapshots require
  separate removal. Encrypt off-Host copies of the database and ledger. Existing exports
  and data already processed by a Harness are outside Engine erasure.

## Phase 1 conformance for Filter out

Inspected [Filter-out PR #179](https://github.com/ralfboltshauser/agent-mail-client/pull/179)
at `7b33c98` against `9f1e6c2`. Comparison paths below refer to that branch. This phase keeps the
branch's F, Shift+F, Shift+X, managed Filtered destination, and recoverable owner Restore.

| In-flight location | Required delta before first release |
| --- | --- |
| `apps/engine/src/mail/triage/filtering-migration.ts`, v23 | Keep `filtered_destination`, nullable `message.list_id` and optional per-arrival suggestion projection. Replace `triage_prediction`, `triage_annotation`, and mutable `owner_action.reason` with the event and reason tables above. Separate producer fields, reserve policy/rule IDs as nullable, and make work refer to prediction. Replace writable `invalidated_at`, `superseded_by` and stored FP/FN with derived state. Rebind advances generation. If v23 reaches any persistent instance first, use an additive next migration and preserve legacy rows. |
| `mail/triage/annotations.ts` | Replace `annotateUndo`, `invalidateAnnotations`, and `editOwnerReason` row edits with log operations, generation fencing and reason revision append. Replace Account-salted SHA with keyed HMAC. Capture features on both event sources. Replace “latest prediction for message” with exact displayed or verified placement reference. Use log examples with the shared budget and no copied content or default raw reasons. Keep verdicts separate from verified moves. |
| `mail/triage/filtering.ts` | Delete the `hasPositiveFilterExample` execution gate and automatic enqueue in `suggestFilter`. Log predictions and use review cards for every suggested Filter. Keep branch safety checks as suggestion context and extend structured protection to billing and potentially Interrupt-worthy mail. Restore links exact verified placement, and owner F/Restore append one decision per frozen message, including mixed Threads. Undo targets event IDs under the existing work-status contract. Never count every owner F as a miss. |
| `mail/triage/corrections.ts`, `mail/senders/actions.ts`, Bucket HTTP | Capture owner Bucket review, manual set/clear, and Sender Accept/Block/Clear plus accepted Undo. Keep v21/v22 tables for compatibility. Replace fabricated review reason with optional private `ownerReason`. Keep exact retry and owner validation. Confirmed reply, Archive, Snooze and Skip are workflow actions without an annotation label unless the owner explicitly supplies one. |
| `packages/protocol/src/{buckets,smart-inbox}.ts`, `apps/cli/prompts/triage.md` | Replace `TriageOutcome = Bucket | 'filtered'`, `outcome` on `TriageBucketResult` and packed `version` with separate `bucket` and `filter` outputs, stable decision label IDs, structured protection and explicit producer fields. Reserve rule citation, null for Phase 1. Keep UI words “Filter out”, “Filtered”, “Restore to Inbox” and “Screened out”. |
| `apps/engine/src/mcp/server.ts`, `apps/cli/src/{triage,triage-claude}.ts` | Use the context receipt and lease-only submit tool. Accept one result per requested input and at most one label per enabled axis. If no supported contract, run the old Bucket-only path. Existing legacy MCP/CLI clients cannot trigger Filter by passing null Bucket. Dry-run stays write-free. |
| `apps/engine/src/http/{filtered,senders}.ts`, desktop IPC and CLI | Keep owner list and decision routes with the canonical Label IDs, owner reason revision API and existing status/Undo. Put Filtered destination adoption on its owner route. Keep history summaries owner-only and redacted by default. Defer `/counts` precision and standalone `/corrections` learning surface to the common history/evaluation contract. |
| `mail/mutations.ts`, `mail/senders/destination.ts`, `providers/imap/organise.ts`, renderer review | Keep verified managed destination and inverse machinery. Isolate operation kinds even when reusing `screening_work`. Reject generic Agent access including from Filtered. Keep failed/partial rows reviewable, keep visible recovery and avoid using pending predictions to suppress notifications. |

If the feature branch has already acquired glossary entries, reconcile them on merge into
the glossary terms defined here. Both PRs can share a single **Filtered** entry.

## Phased roadmap

All verification uses synthetic mail, fake Harness responses, and in-memory or scratch
SQLite/provider fixtures. No Host DB or real mail is needed.

| Phase | Scope and timing | Acceptance and verification | Unlocks |
| --- | --- | --- | --- |
| 1. Filter out conformance | **Must do now to avoid lock-in.** Implement table above, including minimal owner move/recovery, event contract, privacy path, version/arrival identity and separate prediction interface. Start in suggestion mode. | Migration fixture at v22 with prior sender/correction data remains operational. Exercise ! in the Thread list and reader, F/Shift+F/X/Shift+X in Triage, Restore, reason revision and Undo. Verify per-message mixed Threads, v22 CLI fallback, duplicate/conflicting retries, intervening arrivals, exact IMAP identity, provider failures, revoke and replay after restart. Harness only sees scoped reads and no reason by default. No automatic provider mutation. | Durable evidence on day one with recoverable manual Filter. |
| 2. Legacy bridge, owner history, export and forget | **Must do now before broader inference or history adoption.** Finish backfill and reconciliation, JSONL export and erase paths. Phase 1 reads fresh events only where legacy completeness is pending. Until erasure ships, keep the first deployment on synthetic mail or omit private reason capture from any real-mail release. | Mixed synthetic v21/v22 fixture preserves existing projections and inverses. Import twice with equal IDs/counts, exercise crash/resume, orphan data, generation change, erasure with shared reasons and restart from backup. Inspect exports and logs for synthetic canary privacy. | Owner portability and explainable history across upgrades. |
| 3. Owner policy and shadow | **Later, can wait.** Add rule editor, lifecycle, scoped proposal/read, and shadow predictions. | Agent or Composer Link cannot activate or alter owner policy. Show exact rule provenance, conflicts, unknown model and expiry. Synthetic shadow runs change no mailbox, notification or owner state. | Owner review of explicit policy against live observations. |
| 4. Replay, metrics and guarded automation | **Later, can wait.** Add held-out replay, per-rule outcomes, owner activation, verified work, manual Keep/confirm controls and kill switch. | Fake Harness fixtures validate as-of evidence, denied cases, leakage checks, per-rule metric math, exact restore joins, protected billing/security and same-Thread races. Test pause, provider partial, cap, and approval change between enqueue and dispatch. | Small opt-in automatic Filter for qualified rules. |
| 5. Active review and drift | **Later, can wait.** Add prioritised queue, daily Filtered review, explicit confirmation, weak exposure and staleness. | Synthetic time and renderer fixtures show deterministic order, one optional reason nudge, no weight for unopened items and single weak signal for exposure. A rule pauses on stale/contradictory evidence. | Faster annotation and policy upkeep. |
| 6. Additional consumers | **Later, can wait.** Enable one axis at a time after owner defines its behavior. | Run Bucket, Interrupt and draft seam fixtures independently. Test that a new label or rule gains no permission or send ability. | Reuse without coupling delivery, placement or drafting. |

## Reuse seam and v1 cuts

Consumers read an axis-specific policy snapshot and return a typed prediction with
evidence and version references. Each consumer keeps authority for its own effect.
Bucket maps an approved assignment to its existing write path. Interrupt can consume
`attention.*` decisions after #10 defines attention policy. Notifications consume a
derived per-message disposition and retain quiet hours, dedupe and Mute. Drafting may
read authorized rule text and actionable Bucket context through the existing
[MCP draft surface](../../apps/engine/src/mcp/server.ts). Draft provenance can cite a
rule and Thread without copying raw annotations. Owner review remains the path to send.
These use cases share facts and checks while keeping separate effect handlers.

V1 excludes fine-tuning, embeddings or vector stores, model-written active rules,
auto-unsubscribe, Spam/Trash automation, historical automatic moves, cross-Account
training, general-purpose rules DSL, hosted training analytics, provider migration of
policy, import UI, drafting changes and notification redesign. Defer alternate destinations,
domain-wide Sender rules, and new notification or follow-up heuristics. Phase 1 needs
one checked-in taxonomy and indexed SQL, not a generic event framework.

## Risks

| Risk | Mitigation |
| --- | --- |
| Important mail disappears | Hard vetoes, explicit per-rule approval, bounded pilot, precise restore, visible review, three distinguishable states for suggested, pending and applied. |
| Sparse labels and correlated mail inflate scores | Held-out Thread groups, report raw counts and missing outcomes, separate live assessment and restore cohorts, enforce per-rule evidence. |
| Mailbox or rule changes race provider dispatch | Fence generation, exact arrival, policy version, provider membership and owner decisions at dispatch, then reconcile the existing journal. |
| Privacy copy proliferates | Central erasable reasons, no copied mail content in examples, engine-local logs and projections, explicit export scope and restore-time erase handling. |
| Triage slows down | Local preview and optional reasons, accepted-intent fast path, bounded example queries off the keypress path, fake slow-provider renderer checks. |
| Sender hints are spoofable | Use provider and structured protection signals as limited evidence. The existing explicit Sender rule is an owner Inbox choice. It cannot certify identity or bypass provider security. |
