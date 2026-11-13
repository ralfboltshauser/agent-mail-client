# How T3 Code drives Claude Code and Codex

Input to [Does ADR 0002 hold for an open-source project?](https://github.com/ralfboltshauser/agent-mail-client/issues/14). Read from `pingdotgg/t3code` `main` @ `f313d0a6c` (2026-11-13). T3 Code is MIT, open source, and its README says: "Your subscriptions. T3 Code does not resell tokens. It drives the agents you are already signed in to."

## Short answer

T3 Code does **not** use the Vercel AI SDK harness agent. It drives each vendor's **own official programmatic interface** against the **CLI the user installed and logged in**:

| | Claude Code | Codex |
|---|---|---|
| Interface | `@anthropic-ai/claude-agent-sdk` (`query()`), dependency `^0.3.321` | `codex app-server` (JSON-RPC over stdio), via its own `effect-codex-app-server` package |
| Which binary | the user's: `pathToClaudeCodeExecutable` = configured `binaryPath` (`ClaudeAdapterV2.ts:2121`) | the user's: `command: settings.binaryPath \|\| "codex"` (`CodexAdapterV2.ts:1716`) |
| Auth | none of its own; reads the user's existing login (`CLAUDE_CONFIG_DIR`, default `~/.claude`) and only *reports* it (`subscriptionType`, `email`, `apiKeySource`; `ClaudeProvider.ts:202`) | the user's `CODEX_HOME` login; one app-server per home |
| Isolated homes | optional `homePath` → sets `CLAUDE_CONFIG_DIR`, deliberately **not** `HOME`, because changing HOME hides macOS Keychain credentials (`ClaudeHome.ts:43`) | optional `homePath` → `CODEX_HOME` |
| Tool control | per query: `tools`, `allowedTools`, `disallowedTools`, `permissionMode`, `canUseTool`, `mcpServers` | app-server approvals and config |
| Its own tools | exposed to the agent as an **MCP server** (`mcpServers`), the same way the T3 orchestration tools reach this very session | same |
| Sandbox | none of its own: it runs the agent as the user, in the project dir | same |

## What this means for each of our three harness problems

1. **"Needs a sandbox we'd write ourselves."** T3 doesn't need one because its agents *are* the user doing coding work. That's a different trust model from AMC, where an agent must never reach mail credentials or send by side channel. Driving the CLI directly removes the WebSocket sandbox *transport* problem (the SDK spawns the CLI as a child process over stdio), but **containment is still ours**: we'd run the CLI as a dedicated Unix user / container with `CLAUDE_CONFIG_DIR` / `CODEX_HOME` pointing at a home that holds only the model login, no owner MCP, plugins or hooks, and use `tools`/`allowedTools` to switch off bash/web built-ins. That is the [sandbox ticket](https://github.com/ralfboltshauser/agent-mail-client/issues/15), simplified.
2. **"Runs its own pinned CLIs and rewrites your login file."** T3's approach avoids this completely: it uses the installed binary and lets that CLI manage its own credentials. Nothing third-party touches the token.
3. **"Anthropic's terms forbid offering claude.ai login."** T3 doesn't *offer* a login: no OAuth flow, no token handling. The user signs in to Claude Code themselves, and T3 drives that installed tool as a local front end. That's the same position AMC would be in. The Agent SDK docs' sentence is still there, and T3 being prominent and open source isn't a legal clearance. But "drive the user's own signed-in CLI, never touch credentials" is the defensible version of ADR 0002; "a library that reads and refreshes the token for you" is not.

## Contrast worth noting: Android push

T3's Android notifications go through **FCM via a hosted relay** run by the maintainers (`docs/operations/android-notifications.md`; Clerk sign-in, Cloudflare queues). A self-hoster's private build needs their own Firebase project and relay. That is exactly the hosted-relay model our [push research](https://github.com/ralfboltshauser/agent-mail-client/issues/6) avoided by choosing UnifiedPush + self-hosted ntfy. T3 confirms the trade-off rather than contradicting it.

## Suggested amendment for ADR 0002 (to decide in the ticket)

Keep "no API keys, use the owner's subscriptions", but change *how*: drive the owner's **installed, owner-logged-in** Claude Code (via the Claude Agent SDK with `pathToClaudeCodeExecutable`) and Codex (via `codex app-server`), the way T3 Code does, instead of the Vercel AI SDK harness agent. AMC never handles model credentials. The AI SDK could still be used for its UI/streaming primitives, but not as the runtime.
