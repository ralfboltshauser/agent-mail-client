---
name: amc-feedback
description: Handle one piece of owner feedback about AMC (a thread opened from AMC's "Send feedback" shortcut, usually with a screenshot and element annotations). Triage it against open issues and PRs, then either attach it to existing work or fix it end to end — implement via subagents, review, merge, deploy, verify — and report back in one short message. Use when a thread starts with "AMC feedback" or the owner says "feedback:" about AMC.
---

# AMC feedback handler

The owner is daily-driving AMC and sends feedback from inside the app. Your job: turn one piece of feedback into a shipped fix (or a well-placed note on existing work) with **zero extra effort from the owner**. The owner should never have to approve, re-explain, or babysit.

## Input

A feedback thread contains some of:
- **Owner text** — what's wrong or wanted. Authoritative.
- **Screenshot** of the AMC window (attached image).
- **Annotations** — Agentation-style list: element selector / React component name, the owner's note per element, optionally selected text.
- **Local log excerpt** — path to a recent, sanitized extract on the Mac. Read it locally if present.
- **Context block** — AMC version (git SHA), app view (route/folder/mode), window size, timestamp. No mail content.

## Privacy (non-negotiable)

Screenshots and annotations can show real mail: senders, subjects, bodies.
- Never copy mail content, names, addresses or subjects from the screenshot into issues, PRs, commits, branch names, test fixtures, logs or subagent briefs. Describe UI instead ("the sender row in the triage card", "a long subject truncates").
- Never upload the screenshot anywhere (GitHub, artifacts, external services). Subagents get a written description, not the image, unless they run locally and need it for visual repro — then pass the local path only.
- Reproduce with synthetic data or `AMC-E2E-` test threads sent to the owner's own addresses only.

## Step 1 — Understand (2 min max)

Restate the feedback as one sentence: **problem → desired behaviour**, plus the affected area (renderer feature folder / engine module / CLI / MCP). If the feedback holds several unrelated points, split it and handle each separately (one issue/PR per point).

Read the file identified by `Local log excerpt` if the thread supplies a path. Match its warnings, errors and correlation IDs to the screenshot timestamp. If screenshot Details show a run ID, run `amc logs --run <id>` on the machine with those logs. For a request ID, run `amc logs --request <id>` on that machine. Include only the relevant event, error class and correlation ID in external reports. If the excerpt has expired, use the correlation ID from the screenshot or continue with the other evidence.

If the owner supplies a snapshot from **Help → Copy Diagnostics** or the command palette, use its versions, Desktop sync state, health warning codes, Engine diagnostic status and recent local warnings to investigate. Use the same external-report limits as for the local excerpt.

Classify:
| Kind | Example | Default path |
|---|---|---|
| Bug | flicker, wrong count, crash, broken key | fix now |
| Polish | spacing, copy, shortcut, small UX | fix now |
| Feature (small, clear) | add a button/key/setting | fix now |
| Feature (large or ambiguous) | new workflow, data model change | issue + spec, ask owner only if truly blocked |
| Question | "why does X…" | answer, no code |

Only ask the owner when the decision is genuinely theirs and can't be defaulted. Otherwise pick the sensible default and say what you picked.

## Step 2 — Triage against existing work

```bash
cd /Users/ralf/Documents/codex/agent-mail-client && git pull -q
gh issue list --state open --limit 100 --json number,title,labels
gh pr list --state open --json number,title,headRefName
gh issue list --state closed --search "<keywords>" --limit 20 --json number,title,closedAt
```
Search by component/area keywords, not mail content. Also check running T3 subagent threads for AMC if available.

Decide:
- **Already fixed on main but not installed** → install (Step 5) and report.
- **Open PR covers it** → add the feedback (described, privacy-safe) as a PR comment; if the PR's author agent is still running, steer it; otherwise make sure it gets finished.
- **Open issue covers it** → comment with the new evidence; if it's small and clearly wanted now, fix it (Step 3) and close the issue via the PR.
- **Closed issue, regression** → new issue referencing the old one, then fix.
- **Nothing exists** → for "fix now" kinds go to Step 3 directly (the PR description is the record); for large features open an `idea` or `enhancement` issue and stop unless the owner said to build.

## Step 3 — Implement (via subagents)

You supervise; Codex subagents do the work. Use `delegate_task` with `providerInstanceId: codex`, model `gpt-6.2-sol`, `options: {reasoningEffort: medium}`, `runtimeMode: full-access`, `isolation: worktree` or a fresh `/tmp` clone.

Every brief starts with:
> NEVER request approval or sandbox escalation. The owner is away. You may write scratch files under /tmp. If something would need approval, skip it and note it.

The brief includes: the one-sentence problem/desired behaviour, the area and likely files (from the annotation's component names/selectors), acceptance criteria, how to verify (unit test + renderer harness for UI, CLI for engine), repo rules (read AGENTS.md incl. Desktop React rules, GLOSSARY.md, ADRs), the privacy rules above, "unsigned commits, open a PR, wait for `gh pr checks N --watch`, don't merge", and "final report: PR URL, head SHA, CI state, what changed, how verified".

Independent feedback items → parallel subagents in separate checkouts. Don't stack conflicting work on the same files.

## Step 4 — Review (one round)

Start a **new** `delegate_task` (role review) with the PR URL, the problem statement and acceptance criteria. Ask it to block only on real harm: correctness, data loss, privacy, security (ADR 0001: sending requires a scoped grant and explicit owner approval; ADR 0002: no API keys), IMAP safety (never plain EXPUNGE), rerender regressions. Fix small findings yourself or via the implementer; don't do a second review round for nits.

## Step 5 — Merge, release, verify

```bash
gh pr checks N --watch
gh pr merge N --squash --delete-branch --match-head-commit <SHA>
cd /Users/ralf/Documents/codex/agent-mail-client && git pull -q && pnpm check
```
Deploy only what changed:
- Engine (`apps/engine`, `packages/*` used by engine, migrations): `pnpm deploy:host`
- Desktop: quit AMC (`osascript -e 'quit app "AMC"'`, wait until the process is gone), `pnpm desktop:install`, `open -a ~/Applications/AMC.app`
- CLI: `pnpm cli:install`

Then verify the actual fix in the running app or CLI (computer use / CLI), on synthetic or `AMC-E2E-` data. Check the new launch reaches `Engine sync phase: live` using the [Desktop startup check](../../../docs/runbook.md#everyday-commands). If deploy or verification fails, fix forward or revert — never leave the owner on a broken build.

If a desktop re-pair is needed: `ssh ralfs-ubuntu 'sudo -n amc-engine pair --desktop'` then `open -a ~/Applications/AMC.app --args --engine-url=https://ralfs-ubuntu.tail4b5789.ts.net:4443 --pairing-code=CODE`. Never type passwords; escalate password prompts only.

## Step 6 — Report back (in the feedback thread)

One short message, owner-facing, plain language:
- **What you understood** (one line).
- **Outcome**: "Fixed and installed" / "Added to #N (in progress)" / "Filed as idea #N" / "Answered".
- What to try now (e.g. "press F in triage").
- Links: PR/issue.
- Anything you defaulted that they may want to change.

No process narration, no mail content.

## Guardrails

- Never send email, never let agents send (ADR 0001).
- Never delete owner data; Host DB is read-only, never select bodies/subjects/addresses.
- Never Accept/Block real third-party senders in tests.
- YAGNI: smallest change that resolves the feedback. One review round.
- If the fix would change the data model or a decided spec (docs/specs, ADRs), update the spec in the same PR or open an issue instead of silently diverging.
