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
pnpm build        # builds all workspace packages
```

See [development profiles](docs/runbook.md#development-profiles) to start an isolated Desktop or Engine.
See [local verification](docs/runbook.md#local-verification) to enable the pre-push check on macOS.

| Path | What |
|---|---|
| `apps/engine` | the Engine: runs on the Host as the `amc` user |
| `apps/cli` | `amc`, the command line Client |
| `packages/protocol` | types and schemas shared by every Client |
| `deploy/`, `scripts/` | Host provisioning and deploys |

## Install the CLI

Run `pnpm cli:install` from the repository root. It builds the bundled CLI and installs
`~/.local/bin/amc`. Use `pnpm cli:install --force` to replace an unmarked launcher.
If the installer finds an unrelated payload at `~/.local/share/amc/amc.mjs`, move
that file aside before retrying. The launcher prefers
`/opt/homebrew/bin/node` and otherwise uses the Node on your `PATH`. Add `~/.local/bin`
to your `PATH` if needed, then run `amc --version` to check the install. Run the same
install command after updating the checkout.

For the Apple silicon desktop app, see the [Mac installation and update steps](docs/runbook.md#mac-desktop-app).

Licensed under MIT.

## Send AMC feedback

Press **⌘⇧F**, or choose **Send Feedback…** from Help or the tray. AMC captures its window. Add a note, optionally click **Annotate** to mark an element, and press **⌘Enter** to open a new thread in the AMC project in T3 Code. You can leave the note blank and add details in T3.

The screenshot may include visible mail. AMC retains the last 20 captures in its private `feedback/` folder. A paired local T3 connection can attach the PNG. Older paired T3 versions use the screenshot’s local path. The local CLI also uses the path when it can run the thread with approval required. If T3 is unavailable, **Copy feedback** copies the prompt and reveals the PNG in Finder.
