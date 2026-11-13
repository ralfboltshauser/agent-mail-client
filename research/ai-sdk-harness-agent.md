# What can the AI SDK harness agent do on our Host?

Research for [#2](https://github.com/ralfboltshauser/agent-mail-client/issues/2). Sources checked on 2026-11-13 against ai-sdk.dev and `vercel/ai@8bc7652` (`@ai-sdk/harness` 1.0.183, `@ai-sdk/harness-claude-code` 1.0.187, `@ai-sdk/harness-codex` 1.0.185).

## Short answer

- **Yes, it can run headless as a long-lived service, but only after we write a local sandbox provider ourselves.** `HarnessAgent` is a plain Node library. It has no UI, and sessions can be detached and resumed. The Claude Code and Codex adapters are "bridge-backed", though: they install and run their own runtime *inside a sandbox* and talk to it over a WebSocket on a port the sandbox exposes. The only sandbox providers shipped are `@ai-sdk/sandbox-vercel`, which is Vercel's **cloud** sandbox and needs `VERCEL_OIDC_TOKEN`, and `@ai-sdk/sandbox-just-bash`, an in-process virtual bash with no real port. Neither fits a self-hosted Engine on `ralfs-ubuntu`. The sandbox interface (`HarnessV1NetworkSandboxSession`, or a basic `SandboxSession` plus an explicit `port`/`portEndpoint`) is public and small, so a local provider (a container or a dedicated Unix user) is buildable. But it is ours to build and maintain. [1][2][3][9]
- **Authentication uses the owner's login, but not the owner's installed CLI.** If no API-key env var is set, the adapter reads the subscription OAuth token from the host. For Claude that is `~/.claude/.credentials.json` on Linux (Keychain on macOS). For Codex it is `~/.codex/auth.json` or the keyring. The adapter refreshes the token itself and **writes it back**, then forwards it into the sandbox. Inside the sandbox it runs its **own pinned** `@anthropic-ai/claude-code` 2.1.319 / `@anthropic-ai/claude-agent-sdk` 0.3.319 and `@openai/codex` 0.167.0, installed with `pnpm install` during bootstrap. [4][5][10][11][12]
- **Custom tools work through both AI SDK tools and MCP.** Host-executed AI SDK `tools` run in our Engine process; the runtime calls them through an injected MCP server, `mcp__harness-tools__*`. External MCP servers go in the adapter's `mcpServers`. [4][6]
- **Per-run tool exposure can be strictly controlled, which satisfies ADR 0001, with caveats.** Tools are set per agent, and per turn via `prepareCall`. Host tools that are filtered out "are not passed to the underlying harness runtime", and a call to one anyway gets `execution-denied`. Simplest of all: build the tools object without `sendMail` when Dangerously Allow Send is off. Built-in tools (bash, write, web) can be removed natively for Claude Code through the Agent SDK `tools`/`disallowedTools` options. For Codex only `bash`, `apply_patch`, `view_image` and `webSearch` can be filtered. **The real ADR 0001 risk is not our send tool. It is the built-ins plus whatever the runtime loads from its HOME** (see risks). [6][7][13]
- **Streaming: yes.** `stream()` returns an AI SDK `StreamTextResult` that is `useChat`/`toUIMessageStream`-compatible. Structured output works on both adapters. **Concurrency** is one runtime process and bridge per session; the docs set no limit. **Rate/usage limits** are the owner's plan quota. **Cost per triage call** is $0 marginal on a subscription but uses plan quota; `result.usage` reports tokens, and Claude Code has `maxBudgetUsd` (estimated). **Latency is not documented anywhere.** It has to be measured in a spike. [1][2][4]
- **The whole layer is experimental**, with "breaking changes between releases". There have been 183 releases so far, and the changelog includes on-disk layout breaks. [1][8]

## Details

### Architecture of a run

`HarnessAgent` (config, built once) → `agent.createSession({ sandboxSession })` → `generate()` / `stream()` per turn → `session.detach()` / `stop()` / `destroy()`. [2]

- The session owns the native conversation history. Only the latest user message is sent per turn; prior messages are not replayed. Resume state comes from `detach()`/`stop()` and must be stored as a secret, because it holds the bridge private key. [2]
- `getSandboxTemplate()` runs the adapter's bootstrap recipe (`pnpm install --frozen-lockfile` of the bridge with Claude Code / Codex, then `claude --version`) under `$HOME/.ai-sdk-harness` *in the sandbox*. This needs Node, pnpm and npm registry access in the sandbox at bootstrap time. [2][10]
- The bridge listens on a sandbox port (default `4000`). The host connects over WebSocket, authenticated with an Ed25519 key pair generated per bridge. Reconnects use exponential backoff with a 30 s default window. `hostDisconnectTimeoutMs` decides whether a turn keeps running after the Engine dies; **by default it keeps running**. [4][5]
- The `workflow-harness` package offers durable, time-sliced turns on Vercel Workflow DevKit. It is optional and not needed for an Engine that owns its own job loop. [14]

### Headless on the Linux Host

Nothing in the harness needs a TTY or a browser. The blocker is the sandbox. The docs say: "Bridge-backed harnesses such as Claude Code and Codex require using a real network sandbox like `@ai-sdk/sandbox-vercel`." [2][4][5] The repo ships only two sandbox packages, `sandbox-vercel` and `sandbox-just-bash`. [9]

Options for AMC:

1. **Write `@amc/sandbox-local` implementing `HarnessV1NetworkSandboxSession`.** It needs `run`, `spawn`, file I/O, `defaultWorkingDirectory`, `ports`, `getPortEndpoint` → `ws://127.0.0.1:<port>`, `stop`, `destroy` and `restricted()`. The network policy and request-transformation methods are optional. Back it with a rootless container or a dedicated `amc-agent` Unix user plus bubblewrap. [3]
2. **Pass a basic `SandboxSession` with `createClaudeCode({ port, portEndpoint })`.** This is documented as the fallback "only when your project cannot expose the full network session". [2]
3. Using Vercel Sandbox (cloud) would move agent execution off the Host and add a Vercel dependency and bill. That conflicts with the self-hosted shape of the map and with ADR 0002's "no second bill".

If the provider has no `addRequestTransformations`, credentials are **forwarded directly** into the sandbox env, so anything that can run a shell in the sandbox can read the OAuth token. [4][5]

### Authentication

`auth: 'auto' | 'direct' | 'ai-gateway' | {env record}`. The default `auto` prefers AI Gateway credentials if any are present. **Set `auth: 'direct'` explicitly**, so a stray `AI_GATEWAY_API_KEY` or `VERCEL_OIDC_TOKEN` can't silently switch AMC to a paid gateway. That would violate ADR 0002. [4][5][11]

- Claude: reads `$CLAUDE_CONFIG_DIR/.credentials.json` (default `~/.claude`), falling back to the macOS Keychain on darwin only. If the token expires soon, it refreshes against `platform.claude.com/v1/oauth/token` and writes the file back. It forwards `CLAUDE_CODE_OAUTH_TOKEN`. [11]
- Codex: reads `$CODEX_HOME/auth.json` or the keyring (`cli_auth_credentials_store`), refreshes, writes back, and forwards `CODEX_API_KEY` plus the `ChatGPT-Account-ID` header against the ChatGPT Codex base URL. [12]
- So the Engine process must run as the Unix user who did `claude login` / `codex login`, for example a systemd **user** service with lingering enabled. If not, `CLAUDE_CONFIG_DIR`/`CODEX_HOME` must point at those files.

### Tools and MCP

Three tool surfaces exist: runtime built-ins, host-executed AI SDK `tools`, and external MCP servers in the adapter's `mcpServers`. [6]

- Host tools take a `contextSchema`/`toolsContext` (for example, the account id) that is never shown to the model or serialized. Tool approval per host tool is `toolApproval: { tool: 'approved' | 'user-approval' | 'denied' | 'not-applicable' }`. [6]
- `activeTools` (allowlist) or `inactiveTools` (denylist) covers built-ins and host tools. Host tools that are filtered out are not sent to the runtime at all. [6]
- `prepareCall` can derive `tools`, `model`, `instructions` and `skills` per turn, and they are frozen for the whole turn. On Codex, changing the tool catalog starts a **fresh native thread**, so context is lost across that boundary. [2]
- Claude Code built-in filtering is native: the bridge maps names such as `bash→Bash` and `webSearch→WebSearch`, plus `WebFetch`, `Agent`, `Skill`, `ToolSearch` and others, onto the Agent SDK's `tools` and `disallowedTools`. [13] `strictMcpConfig: true` ignores `.mcp.json` and user MCP config. [4]
- Codex built-in filtering covers only `bash`, `apply_patch`, `view_image` and `webSearch`. Codex has **no built-in approval** (`permissionMode` must be `allow-all`), and it **cannot be stopped from loading repo `.codex/config.toml`**. [5]

**ADR 0001 recipe.** Construct `tools` per run from the Engine's mail API, and include `sendMail` only when Dangerously Allow Send is on. Set `activeTools` to exactly those tools, so bash, write, web and Agent are all off. Set `strictMcpConfig: true` and no `mcpServers` (Claude). Use an isolated sandbox HOME with no owner settings, MCP config, plugins, hooks or mail credentials. Give the sandbox no network beyond the model API. The tool then does not exist for the agent, which is exposure-based rather than prompt-based, as the ADR requires.

### Streaming, concurrency, limits, cost, latency

- **Streaming:** `stream()` exposes `text-delta`, reasoning, tool-call and tool-result parts, plus dynamic `fileChange` and `compaction` parts. Lifecycle callbacks cover `onToolExecutionStart`/`End` and others, which is useful for the audit log. [1][2][6]
- **Structured output:** both adapters support `output: Output.object({ schema })`. Claude Code uses Agent SDK `outputFormat` and Codex uses `turn/start outputSchema`. This suits triage verdicts. [4][5]
- **Concurrency:** every session is its own runtime process inside the sandbox. Claude Code serializes built-in approvals, and host tools that are not marked `readOnly` run one at a time. The docs set no global limit; the practical limits are Host RAM and plan rate limits.
- **Limits and cost:** subscription use spends the owner's plan quota. Codex docs: "When you sign in with an API key, Codex uses standard API pricing instead of included ChatGPT plan credits." [15] `maxBudgetUsd` (Claude) caps estimated spend per query, and `maxTurns` caps loop length. [4]
- **Latency:** no published numbers. Expect a one-time bootstrap (pnpm install of Claude Code) per template, a process spawn per session, then normal model latency. `turnStartTimeoutMs` defaults to 120 s. **A spike should measure a cold session and a warm triage turn on the Host.**

### What it does not support (or not well)

- No first-party local or Docker sandbox provider. [9]
- No `readHistory()` on Claude Code or Codex (✗ in the capability table). [7]
- Codex: no built-in approvals, filtering limited to four built-ins, no raw `apply_patch`/`view_image` events after a cold resume, and repo `.codex/config.toml` always loads. [5]
- Claude Code: the adapter disables project-level settings and hooks, so project `AGENTS.md`/skills are **not** discovered natively. Pass skills explicitly via `skills`. [4]
- Uses its own pinned CLI versions, not the owner's installed `claude`/`codex` binaries. [10]
- No API stability guarantee. [1]

## Open risks

1. **Anthropic terms for subscription login in third-party products.** The Claude Agent SDK overview says: "Unless previously approved, Anthropic does not allow third party developers to offer claude.ai login or rate limits for their products, including agents built on the Claude Agent SDK. Use the API key authentication methods..." [16] AMC is an OSS product that would ship exactly this path, and ADR 0002 forbids the API-key alternative. The Vercel adapter does it anyway, but that doesn't make it allowed. **This needs an owner decision.** It may be acceptable for personal self-hosting, but it is risky for an OSS project that recommends it. OpenAI also recommends API keys for "programmatic Codex CLI workflows". [15]
2. **Refresh-token races.** The adapter refreshes and rewrites `~/.claude/.credentials.json` / `~/.codex/auth.json` while the owner's interactive CLI on the same account does the same. If the providers rotate refresh tokens, one side could invalidate the other. Not verified; test in the spike.
3. **Built-ins are the real send path.** `bash` or `WebFetch` plus network access plus any mail credential reachable in the sandbox equals sending without the send tool. ADR 0001 holds only if built-ins are allowlisted off **and** the sandbox has no credentials or network beyond the model API.
4. **User-level config leakage.** The Claude bridge passes `settingSources: ['user']` [13] and Codex reads the sandbox HOME's `config.toml` [5]. If the "sandbox" is the owner's real HOME, their MCP servers, plugins and hooks become agent tools. The sandbox must have its own HOME.
5. **We own a sandbox provider** against an experimental interface that has already broken its on-disk layout. [8]
6. **Runaway turns.** By default a turn keeps running after the Engine disconnects. Set `hostDisconnectTimeoutMs`. [4]
7. **Codex is the weaker adapter for strict control.** No approvals, partial filtering, and repo config always loads. Claude Code is the better default for triage; for Codex, run with an empty workdir.

## Citations

1. AI SDK Harnesses overview: https://ai-sdk.dev/docs/ai-sdk-harnesses/overview
2. HarnessAgent: https://ai-sdk.dev/docs/ai-sdk-harnesses/harness-agent
3. `HarnessV1NetworkSandboxSession` interface: https://github.com/vercel/ai/blob/8bc7652cdb13fc84722666eb93f45acd0d131eee/packages/harness/src/v1/harness-v1-network-sandbox-session.ts ; `Experimental_SandboxSession`: https://ai-sdk.dev/docs/reference/ai-sdk-core/sandbox
4. Claude Code adapter: https://ai-sdk.dev/providers/ai-sdk-harnesses/claude-code
5. Codex adapter: https://ai-sdk.dev/providers/ai-sdk-harnesses/codex
6. Harness tools: https://ai-sdk.dev/docs/ai-sdk-harnesses/tools
7. Harness adapters / capability table: https://ai-sdk.dev/docs/ai-sdk-harnesses/harness-adapters
8. `@ai-sdk/harness` CHANGELOG: https://github.com/vercel/ai/blob/main/packages/harness/CHANGELOG.md
9. Repo packages (only `sandbox-vercel`, `sandbox-just-bash`): https://github.com/vercel/ai/tree/main/packages ; just-bash README: https://github.com/vercel/ai/blob/main/packages/sandbox-just-bash/README.md
10. Bridge pinned deps: https://github.com/vercel/ai/blob/main/packages/harness-claude-code/src/bridge/package.json , https://github.com/vercel/ai/blob/main/packages/harness-codex/src/bridge/package.json ; bootstrap recipe: https://github.com/vercel/ai/blob/main/packages/harness-claude-code/src/claude-code-bootstrap.ts
11. Claude subscription resolution: https://github.com/vercel/ai/blob/main/packages/harness-claude-code/src/claude-code-subscription.ts
12. Codex subscription resolution: https://github.com/vercel/ai/blob/main/packages/harness-codex/src/codex-subscription.ts
13. Claude bridge tool filtering / `settingSources`: https://github.com/vercel/ai/blob/main/packages/harness-claude-code/src/bridge/tool-filtering.ts , https://github.com/vercel/ai/blob/main/packages/harness-claude-code/src/bridge/index.ts
14. Workflow utilities: https://ai-sdk.dev/docs/ai-sdk-harnesses/workflow-utilities
15. Codex authentication: https://learn.chatgpt.com/docs/auth (redirected from https://developers.openai.com/codex/auth)
16. Claude Agent SDK overview (third-party login note): https://code.claude.com/docs/en/agent-sdk/overview
