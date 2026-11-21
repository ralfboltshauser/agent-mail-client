# The Engine runs as its own system user, so Agents on the Host cannot reach mail credentials

ADR 0001 says Agents cannot send because the send tool is never exposed to them. On the Host, that is not enough by itself. T3 Code, Codex and Claude Code agents run as the owner's Unix user (`ralf`) with full shell access. If the Engine also ran as `ralf`, any of those Agents could read its OAuth refresh tokens and call Gmail's send endpoint directly, and the guarantee would rest on Agent behaviour again.

So the Engine runs as a dedicated system user, `amc`. Its database, blobs, encryption key and provider credentials live in directories only `amc` can read (`/srv/amc`, `/etc/amc`, later `/var/lib/amc`).

The Engine's own agent runner is the only AMC process that runs as `ralf`, because it must use the owner's logged-in Claude Code and Codex (ADR 0002). Each Harness reaches mail through its private MCP forwarder, which holds the scoped Agent token under a separate service identity. [ADR 0004](0004-confine-the-agent-runner-on-the-host.md)

## Consequences

- Sending is impossible for any process running as `ralf` unless it holds an owner token or an agent token with the `send` scope, and the latter also requires Dangerously Allow Send and exact-draft owner approval.
- Deploys need `sudo` on the Host to install releases and restart the system service.
- The owner's `amc` CLI on the Host authenticates with a token like any other Client; it does not read the database directly.
- On the Mac, the owner token lives in the Keychain, restricted to the AMC app, for the same reason.

## Open risk: passwordless sudo

On the owner's Host, `ralf` has passwordless `sudo`. Any process running as `ralf` (including a coding agent in full-access mode) can therefore still become `amc` or root and read the Engine's secrets. The separation holds only once `sudo` asks for a password (or the agents run as a user without `sudo`). Until the owner decides, ADR 0001 is guaranteed against AMC's own confined Agents but not against an arbitrary coding agent that deliberately escalates with `sudo`.
