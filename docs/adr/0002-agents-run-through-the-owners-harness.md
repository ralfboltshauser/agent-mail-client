# Agents run through the owner's installed, logged-in CLIs; AMC never handles model credentials

Every Agent runs on the Claude Code and Codex CLIs the owner has already installed and logged in on the Host, so it rides their existing subscriptions with no API keys (not even as a fallback). AMC drives them directly the way T3 Code does: Claude through the Claude Agent SDK pointed at the installed `claude` binary, Codex through the installed `codex app-server`. Both share the owner's existing login (`~/.claude`, `~/.codex`), and only the CLIs themselves ever refresh it.

## Considered Options

- **Vercel AI SDK harness agent** (the original choice). It gives the same tool control, since underneath it is the same Agent SDK `query()` and `codex app-server`, plus one API across both providers. Rejected because it runs its own pinned CLIs and **refreshes and rewrites the credential files itself**. On a Host where T3 Code and several Codex processes already share one login, a second, uncoordinated refresher invalidates single-use refresh tokens and forces repeated re-logins. A separate AMC-only login would avoid the race but means logging in twice every time a provider forces re-authentication. One shared login that only the CLIs refresh is the only option with neither problem.
- **API-key providers.** Rejected: second bill, key management.

## Consequences

- We write two thin adapters (Claude, Codex) instead of getting one API for free. AMC's agent work is short triage, drafting and workflow calls, not full coding sessions, so they stay small.
- Sharing the owner's login means sharing their config directories. Agent runs must explicitly load **no** owner settings, MCP servers, plugins or hooks (see the sandbox ticket).
- Anthropic's Agent SDK terms discourage third-party products offering claude.ai login. AMC offers no login and touches no token; it is a front end for the owner's own signed-in tool, the same posture as T3 Code. This is an accepted, revisitable risk.
