# Mail from the AMC CLI

Use a paired `amc` for owner commands. For an agent, pass a scoped grant through
`AMC_TOKEN` and run commands with `--as-agent`. Set `AMC_ENGINE_URL` when the
Engine URL differs from the local pairing or the machine has no pairing.
Agent mode requires an Engine that recognizes and verifies scoped CLI access.
It uses the explicit token for every request.

```sh
amc --as-agent search --account <account-id> --json 'subject:Project'
amc --as-agent thread <thread-id> --json
amc --as-agent reply <thread-id> --body-file - --json < reply.txt
amc --as-agent draft create --account <account-id> --to reader@example.com \
  --subject 'Project update' --body-file update.txt --json
amc --as-agent draft show <draft-id> --json
amc --as-agent draft update <draft-id> --revision <revision> --body-file revised.txt --json
```

Use `--reply-all` to include the other thread recipients. Repeat `--to`, `--cc`,
or `--bcc` to override a recipient field. Each takes an address or
`'Name <address>'`. Pass an empty value by itself to
clear that field. Draft writes return the AMC ID, revision, and current provider
mirror status when supported. Draft-only grants receive a receipt without mail
content. If a draft changed, inspect the new revision before editing or
discarding it. If the Engine loses the response to a write, check AMC before
retrying. Send the reviewed draft from AMC desktop.

For agent batches, add up to 19 more distinct thread IDs with repeatable
`--thread <id>`. A queued action returns an ID you can check with
`amc --as-agent agent status <action-id> --json`.

| Operation | Command |
| --- | --- |
| Grant, accounts, labels | `whoami`, `accounts`, `labels` |
| Mail and contacts | `threads`, `thread`, `message`, `search`, `contacts` |
| Drafts | `draft create`, `reply`, `draft list`, `draft show`, `draft update`, `draft discard` |
| Organize and check writeback | `archive`, `read`, `unread`, `star [--remove]`, `mute`, `label [--remove]`, `agent status` |
| Agent triage and suggestions | `triage untriaged`, `bucket`, `senders suggest` |

Discard requires the paired owner. Handoff grants support `thread`, `draft show`,
and body-only `draft update` for their assigned items. Account-scoped grants
cannot search the owner’s shared contacts. Lease-bound model predictions and
review context belong to the triage runner.

## Authorization and state

```mermaid
flowchart LR
  Shell[Owner or shell agent] --> CLI[AMC named commands]
  Client[MCP client] --> MCP[Engine MCP tools]
  CLI -->|Scoped grant and draft commands| MCP
  CLI -->|Existing paired commands| HTTP[Engine mail HTTP API]
  MCP --> State[Engine mail store and agent audit]
  HTTP --> State
  State --> Provider[Gmail or IMAP]
  Desktop[AMC desktop] -->|Owner send approval| Outbox[Engine outbox]
```

The Engine owns draft state, thread state, provider writeback, and audit.
Scoped commands and revision-checked owner writes use versioned MCP routes.
The Engine checks the credential before dispatching, and an older Engine
rejects those routes even if a rollback happens between discovery and the
write. The CLI checks which draft fields the grant can edit. Existing paired
reads and owner mutations retain their HTTP behavior and output shapes.
