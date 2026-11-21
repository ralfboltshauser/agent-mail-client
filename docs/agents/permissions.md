# Agent permissions in M6

Design for [#9](https://github.com/ralfboltshauser/agent-mail-client/issues/9) and [M6](https://github.com/ralfboltshauser/agent-mail-client/issues/30). The Engine owns authorization. The Harness allow-list is a second check.

## Grants and tool exposure

| Scope | Capabilities |
| --- | --- |
| `read` | List and search allowed Accounts, Threads, Labels, contacts, attachments and drafts. Reading a draft requires `read`, preserving the current behavior. |
| `organize` | Archive, Label, Snooze, Mute, mark read and set triage fields. |
| `draft` | Create, update and comment on Agent Drafts. Keep existing discard only once it has a recoverable snapshot. Composer Links, when shipped, are edit-only for one draft and expire after 24 hours. |
| `send` | Explicitly granted `send_draft` on allowed Accounts while **Dangerously Allow Send** is on. |
| `admin` | Reserved for authorized owner Clients. Agents cannot issue or revoke tokens or change settings. |

Hard delete and unsubscribe stay outside Agent scopes. Unsubscribe can send mail or trigger an external request. Trash stays owner-only in M6.

- The owner approves a scope ceiling and Account set per workflow or external Client. Each run gets only what it needs within that grant, narrowed to specific Threads or drafts where the job knows their IDs. Triage gets `read` and `organize`. An external T3 Code session starts with explicitly approved `read` on selected Accounts. Drafting requires an explicit `draft` grant. Pairing tokens and Composer Links have their own principal kinds.
- Issue a new random bearer once at launch, store its hash, and bind token ID to run, workflow or external Client identity, scope, resource constraints and expiry. Start with a two-minute run deadline and at most five minutes of token lifetime, including startup. Revoke on completion, cancellation, timeout or owner action. Start external grants with a 30-minute expiry and require a fresh grant after expiry. The Engine mints internal run tokens when dispatching approved work. The runner never receives a reusable admin credential or an endpoint that accepts arbitrary scope requests from its Unix user.
- Use one Engine operation registry for scope and principal checks, request schemas, tool registration and CLI capabilities. Compute the Harness allow-list from the same run grant. Resolve Account ownership at execution for every Thread, draft, attachment and Label. Apply constraints before search, paging, joins and result counts. Cover mixed-Account batches and mismatched explicit and inferred Accounts. Authenticate MCP requests afresh and authorize each action when it executes. An absent tool must fail a direct `tools/call`.
- Today the Engine builds a stateless MCP server from scopes per request. Tokens support expiry and revocation and reject new Agent `send` grants while the setting is off. Account constraints and run identity are absent from `Principal`, and the token API accepts grants with no expiry. Ship mandatory ceilings, resource checks and TTLs with M6. No send tool exists in the current MCP implementation. [MCP registration](../../apps/engine/src/mcp/server.ts) · [Authentication](../../apps/engine/src/auth/tokens.ts) · [Token API](../../apps/engine/src/http/tokens.ts) · [Scopes](../../packages/protocol/src/scopes.ts)

## Dangerously Allow Send

Only the confirmed desktop owner action may change the setting. Notify the owner when it is enabled. An Agent needs a separate scoped grant explicitly permitting send and the live toggle at listing, invocation and provider dispatch. Apply this rule to MCP, HTTP, `amc`, batch mutations, the outbox and delayed retries. The regular paired CLI and Composer Link cannot send. The desktop owner send path remains independent. [ADR 0001](../adr/0001-agents-cannot-send-by-construction.md)

On disable, revoke send-bearing Agent tokens and cancel pending Agent sends. Serialize the gate with claiming and starting provider dispatch so a queued action authorized before disable cannot begin afterward. Record whether dispatch already started. A provider may still accept an in-flight request after disable. Re-enabling must require a fresh send grant. Treat ambiguous provider outcomes as unresolved and reconcile before retrying.

## Action history, undo and limits

Write every invocation outcome against the run and token ID in `agent_action`. Record tool, target, timestamp, result and mutation ID. Store minimal sanitized arguments and before/after state for reversible changes. Exclude bearer secrets and raw read results. Persist the successful mutation, undo data and writeback enqueue atomically. The desktop shows attribution and status, including rejected and failed writes.

Undo is an owner-authorized, idempotent compensating mutation through the M3 writeback queue. Check the fields and versions changed by the original action and surface conflicts if a newer owner or Agent edit would be overwritten. Use attributed inverse operations for live drafts once Yjs lands. A successfully dispatched send cannot be undone.

Start with two internal runs at once, 20 starts per workflow per hour, 60 tool calls and 20 reversible writes per grant per minute. Count by workflow or external Client as well as by token so reissuing a token cannot reset the budget. Bound batch size, result bytes and affected objects. If enabled, cap Engine-wide Agent sends at one per minute and five per hour initially. Enforce counters atomically before mutations, return a retry delay, and keep provider quota handling separate. These are starting values for M6.

## ADR 0001 regression suite

Use a fake Engine database, fake Gmail and SMTP dispatch, and a captured provider-call counter.

1. With the switch off, enumerate every subset of `read`, `organize`, `draft` and `send`. Seed stale `send` tokens minted while on. Assert MCP discovery omits send, direct MCP send is rejected, and every HTTP, CLI, composer and batch path denies access to send for Agent principals. Verify zero outbox inserts and provider calls. Assert Agent issuance rejects `admin` and send while off.
2. With the switch on, prove only an explicitly scoped Agent on an allowed Account can send. Test desktop confirmation and auditing, owner send with the switch off, and no send for a regular CLI or Composer Link. Try cross-Account IDs, expired/revoked grants and shape-valid forged requests.
3. Turn the switch off after discovery, after enqueue, and during a dispatch race. Prove no new Agent provider submission starts after disable. Test stale grants across restart and a subsequent enable. Cover the already-started send outcome and retry reconciliation separately.
4. Check that unrelated scopes cannot read or mutate outside the grant. Test idempotency, concurrent edits and undo, audit redaction and rate limits. Exercise permissions through both transport surfaces as well as at the mutation and provider boundary.
