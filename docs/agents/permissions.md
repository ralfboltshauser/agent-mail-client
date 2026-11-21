# Agent permissions in M6

Design for [#9](https://github.com/ralfboltshauser/agent-mail-client/issues/9) and [M6](https://github.com/ralfboltshauser/agent-mail-client/issues/30). The Engine owns authorization. The Harness allow-list is a second check.

## Grants and tool exposure

| Scope | Capabilities |
| --- | --- |
| `read` | List and search allowed Accounts, Threads, Labels, contacts, attachments and drafts. Reading a draft requires `read`, preserving the current behavior. |
| `organize` | Archive, Label, Snooze, Mute, mark read and set triage fields. |
| `draft` | Create, update and comment on Agent Drafts. Keep existing discard only once it has a recoverable snapshot. Composer Links, when shipped, are edit-only for one draft and expire after 24 hours. |
| `send` | Explicitly granted `send_draft` for one owner-approved draft version and envelope while **Dangerously Allow Send** is on. |
| `admin` | Reserved for authorized owner Clients. Agents cannot issue or revoke tokens or change settings. |

Hard delete and unsubscribe stay outside Agent scopes. Unsubscribe can send mail or trigger an external request. Trash stays owner-only in M6.

- The owner approves a scope ceiling and Account set per workflow or external Client. At dispatch, the Engine stores an immutable job ID, mode, operation allow-list and per-operation target IDs derived from the approved workflow and Engine-selected inputs. Triage gets read and organize operations on its input Thread IDs within the approved Accounts. It cannot draft or expand its target set. Mail, attachments and Harness output cannot add operations or targets. External Clients use an owner-approved job with explicit Accounts, operations and target constraints. A new T3 Code grant starts with read.
- Mint a random bearer, store its hash and bind it to the job, run or external Client, Account set, operation and target constraints, and expiry. Start with a two-minute run deadline and a five-minute maximum token lifetime including startup. Keep internal bearers in the trusted forwarder. Revoke on completion, cancellation, timeout or owner action. External grants expire after 30 minutes and require a fresh grant. Pairing tokens and Composer Links have separate principal kinds.
- Use one Engine operation registry for discovery and dispatch across MCP, HTTP and CLI, including batch items and queued work. Validate the grant on every Agent request. Authorize every action against the stored job and resolve all target Accounts at execution. Constrain reads before search, paging, joins and counts. Reject a direct call to an absent tool and reject an unauthorized batch in full before mutating.
- Before opening M6 Agent endpoints, revoke all pre-M6 Agent tokens in the migration. Owners may explicitly approve fresh grants. Every Agent surface rejects missing expiry, empty or missing Account ceilings, and missing or invalid job metadata, including for tokens restored from older data. [Current authentication](../../apps/engine/src/auth/tokens.ts) · [Current token API](../../apps/engine/src/http/tokens.ts)

M6 checks a draft's current From Account against the Agent's Account ceiling. Draft-only grants receive a write receipt with the draft ID, revision and status. They can update drafts they created under that grant.

The organise queue rechecks the Agent grant immediately before starting a Gmail mutation. Replica event streams recheck the grant before each event and periodically while idle. The Engine owns Gmail draft mirroring after a draft is saved locally. Mirror retries can continue after the grant expires or is revoked.

## Dangerously Allow Send

Only the confirmed desktop owner action may change the setting. Notify the owner when it is enabled. Unattended jobs are always send-free. An interactive Agent needs a live send grant and a separate, single-use desktop approval bound to the job, Account, draft ID, immutable draft version and exact recipient envelope (To, Cc and Bcc). Any edit invalidates the approval. Atomically consume it at enqueue, freeze the approved payload, and recheck grant, version, envelope and toggle before starting provider dispatch. Apply the gate to MCP, HTTP, `amc`, batches, the outbox and retries. The regular paired CLI and Composer Link cannot send. Desktop owner send is independent. [ADR 0001](../adr/0001-agents-cannot-send-by-construction.md)

On disable, atomically revoke send-bearing Agent grants, invalidate affected internal sessions and their approvals, and cancel pending Agent sends. The forwarder closes affected MCP connections and the runner terminates the affected Harness processes, discards their tool schemas and closes their UI sessions before acknowledging completion. Serialize disable, draft edits and grant revocation with outbox claims and provider dispatch start. Record already-started attempts and reconcile ambiguous provider outcomes before retrying. Fresh discovery omits Send. External Clients may cache an old schema, but the Engine rejects every stale call, including after restart or re-enable. Any fresh send requires a new session, grant and approval.

## Action history, undo and limits

Write every invocation outcome against the run and token ID in `agent_action`. Record tool, target, timestamp, result and mutation ID. Store minimal sanitized arguments and before/after state for reversible changes. Exclude bearer secrets and raw read results. Persist the successful mutation, undo data and writeback enqueue atomically. The desktop shows attribution and status, including rejected and failed writes.

Undo is an owner-authorized, idempotent compensating mutation through the M3 writeback queue. Check the fields and versions changed by the original action and surface conflicts if a newer owner or Agent edit would be overwritten. Use attributed inverse operations for live drafts once Yjs lands. A successfully dispatched send cannot be undone.

Start with two internal runs at once, 20 starts per workflow per hour, 60 tool calls and 20 reversible writes per grant per minute. Count by workflow or external Client as well as by token so reissuing a token cannot reset the budget. Bound batch size, result bytes and affected objects. If enabled, cap Engine-wide Agent sends at one per minute and five per hour initially. Enforce counters atomically before mutations, return a retry delay, and keep provider quota handling separate. These are starting values for M6.

## ADR 0001 regression suite

Use a fake Engine database, fake Gmail and SMTP dispatch, and a captured provider-call counter.

1. With the switch off, enumerate every subset of `read`, `organize`, `draft` and `send`. Seed stale `send` tokens minted while on. Assert MCP discovery omits send, direct MCP send is rejected, and every HTTP, CLI, composer and batch path denies access to send for Agent principals. Verify zero outbox inserts and provider calls. Assert Agent issuance rejects `admin` and send while off.
2. With the switch on, require a scoped interactive grant and one exact-version and exact-envelope approval. Reject cross-Account IDs, changed content or To/Cc/Bcc, duplicate consumption, forgery and expired/revoked grants. Exercise owner send with the switch off.
3. Disable after discovery in a live internal run, after enqueue and during a dispatch race. Assert the internal Harness and its UI session close, fresh discovery omits Send, and stale internal and external calls fail after disable, restart and re-enable. Verify no new provider submission starts after disable and cover an already-started attempt separately.
4. Feed synthetic hostile mail and attachments to an unattended triage job. Attempt unrelated Thread mutations, a mixed-target batch, draft edits and send with the toggle on. Check zero unauthorized mutations, outbox inserts and provider calls. Exercise reads, idempotency, undo, audit redaction and rate limits.
5. Upgrade a database seeded with a valid legacy M1b token. Assert revocation and denial through discovery, direct MCP calls, HTTP and CLI. Repeat for grants individually missing expiry, Accounts or job metadata. Verify a fresh owner-approved grant works.
