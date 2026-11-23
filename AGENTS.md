# Desktop React rules

- Before editing or reviewing the renderer, read [Vercel React Best Practices](.agents/skills/vercel-react-best-practices/SKILL.md). Apply the relevant rules for Effects, data loading, and re-renders.
- For component APIs and state ownership, read [Component Design](.agents/skills/component-design/SKILL.md).
- For sync, typing, lists, or layout changes, read [Performance](.agents/skills/performance/SKILL.md). Check commits and DOM continuity with synthetic mail when the change affects rendering.
- Use the [desktop React audit](docs/desktop-react-audit.md) for the baseline and regression budgets.

## Renderer size guideline

Review handwritten files around 300 lines and components around 150 lines. Split when responsibilities, state ownership, or update rates differ. Keep cohesive behavior together.

## Desktop React PR checklist

- [ ] Name the source of truth and owner for new state.
- [ ] Check no-op sync, changed-row, or typing budgets when the diff touches those paths.
- [ ] Check keys, selection, focus, scroll, and DOM continuity across refresh and retry.
- [ ] Exercise slow, failed, and out-of-order responses when changing reads or writes. Show empty state after an accepted result.
- [ ] Verify draft durability, reviewed revisions, and send/undo when changing composer or delivery.
- [ ] Run the affected renderer tests. For layout, focus, and native behavior, reproduce in an isolated Electron profile with synthetic mail.

## Desktop feedback

The owner can open a feedback thread from AMC with **⌘⇧F**. Use the [AMC feedback skill](.agents/skills/amc-feedback/SKILL.md) when a thread starts with “AMC feedback”.

## AMC change requests

Use the [AMC work skill](.agents/skills/amc-work/SKILL.md) when asked to fix a bug, polish the UI, change an interaction, or build a feature in AMC. It routes the work and registers the steps in T3's Tasks drawer. Feedback intake hands off to the same skill.

## Agent workspaces and scratch files

- For implementation and review delegates, target the AMC project and use T3-managed worktree isolation. For a read-only review, inspect the branch or PR diff directly if it already has the evidence you need.
- T3 installs dependencies before the first turn in a worktree. If setup fails, inspect its terminal before retrying. In a manual checkout, run `pnpm install --frozen-lockfile`.
- Run searches and checks independently of cleanup. Use a temporary-file API with scoped cleanup for disposable probes. Codex asks for approval for forced deletes even inside shell exit traps, so adding one can block the check before it starts.
- Start dev apps in the current session. Stop them through the session or by the PID captured at launch. Process-name searches can match someone else's instance.
- Use the [development profiles](docs/runbook.md#development-profiles) for app checks. The installed Desktop profile and the Host's database and credentials belong to the live app. Use synthetic mail and provider fakes for test data.

## Verification

- For a behavior bug, reproduce it at the lowest layer that owns it. Extend the existing case when possible, observe it fail before fixing it, and await the relevant write or event in async tests. For a visual change, capture the before and after using synthetic data.
- Trace any changed behavior through the entry points that expose it. For Engine changes, check the affected Desktop, CLI, and MCP callers and the shared protocol. Include retry, undo, or account changes when they can alter the result.
- Iterate with `pnpm exec vitest run <affected test files>` and `pnpm exec biome check <changed files>`. Use the [renderer harness](test/renderer/README.md) for App behavior with synthetic IPC. CI runs the full `pnpm check` and `pnpm build`.
