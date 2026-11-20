# The Engine runs as its own system user, so Agents on the Host cannot reach mail credentials

ADR 0001 says Agents cannot send because the send tool is never exposed to them. On the Host, that is not enough by itself. T3 Code, Codex and Claude Code agents run as the owner's Unix user (`ralf`) with full shell access. If the Engine also ran as `ralf`, any of those Agents could read its OAuth refresh tokens and call Gmail's send endpoint directly, and the guarantee would rest on Agent behaviour again.

So the Engine runs as a dedicated system user, `amc`. Its database, blobs, encryption key and provider credentials live in directories only `amc` can read (`/srv/amc`, `/etc/amc`, later `/var/lib/amc`).

The Engine's own agent runner is the only AMC process that runs as `ralf`, because it must use the owner's logged-in Claude Code and Codex (ADR 0002). It holds a scoped agent token and reaches mail only through the Engine's MCP API, like every other Agent.

## Consequences

- Sending is impossible for any process running as `ralf` unless it holds an owner token or an agent token with the `send` scope, and the latter exists only while Dangerously Allow Send is on.
- Deploys need `sudo` on the Host to install releases and restart the system service.
- The owner's `amc` CLI on the Host authenticates with a token like any other Client; it does not read the database directly.
- On the Mac, the owner token lives in the Keychain, restricted to the AMC app, for the same reason.
