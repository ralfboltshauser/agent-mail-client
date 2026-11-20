# agent-mail-client (AMC)

An open-source, agent-native mail client for founders who live in their agents.

- **Engine first.** An always-on mail engine on your own host; the keyboard-first desktop app, the Android app, and your agents (Claude Code, Codex, T3 Code) are all equal clients of it.
- **Attention defence.** Your phone only buzzes for mail worth interrupting you — and you can always see why.
- **Trust by construction.** Agents cannot send mail unless you explicitly enable it; the send capability is not merely discouraged, it does not exist for them.

Status: being built. See the [build plan](docs/plan.md), the [runbook](docs/runbook.md) and the `wayfinder:map` issue.

## Development

Requires Node 22.13+ (the Host runs Node 26) and pnpm.

```sh
pnpm install
pnpm check        # typecheck, lint, test
pnpm build        # bundles apps/engine and apps/cli into dist/
```

| Path | What |
|---|---|
| `apps/engine` | the Engine: runs on the Host as the `amc` user |
| `apps/cli` | `amc`, the command line Client |
| `packages/protocol` | types and schemas shared by every Client |
| `deploy/`, `scripts/` | Host provisioning and deploys |

Licensed under MIT.
