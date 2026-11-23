---
name: amc-work
description: Run AMC changes from direct requests or sanitized feedback through T3 Todos, local verification, and PR merge.
---

# AMC work

## 1. Triage and choose a path

Start **Triage request and check existing work** with `update_plan`, the provider's native task tool, or a thread checklist. Identify the expected behavior and search AMC code, open issues, and PRs by feature or component. Include closed work for regressions. Link duplicates and reuse their evidence. Answer questions in place. For deferred work, record the sanitized scope, evidence, and proposed next step in the thread or requested destination.

**Routine fixes.** Use one agent in the current isolated worktree when the behavior is clear, one implementation area owns the change, and state ownership, persisted data, permissions, and public contracts stay the same. A known tooltip setting, a spacing adjustment, or a regression with a clear local cause can fit here. After triage, register **Implement and verify the fix** and **Push, merge, and clean up** in one update. Trace the owning code and reuse its patterns. Consult an external source when the repo leaves a decision open. Switch paths if the change crosses a boundary or reveals an unresolved design choice.

**Design and cross-cutting changes.** For a new capability, an unsettled UX decision, or a fix that spans owners, add a research Todo before implementation. Trace affected callers, state owners, and entry points. Compare firsthand sources when they can resolve a design decision. For UX choices, new capabilities, and architecture decisions, compare at least two relevant approaches when available. Use generic search terms and synthetic examples. Add **Map and review architecture** and read the [C4 guide](architecture.md) for app or process boundaries, changes to state ownership, persisted data or permissions, or work that needs several independently verifiable slices. Make dependencies explicit. Register the applicable stages in one update and keep Todos current as work starts, finishes, or blocks.

Keep one short record in the T3 thread or linked issue with the expected behavior, owning code, and how to verify it. Add research links and the decision when they affect the implementation. Reuse the record for handoffs, the PR, and the final reply. Keep a separate artifact for durable design or architecture decisions.

## 2. Implement and review

Reuse the task's isolated worktree. From a shared checkout, create an isolated worktree before editing. Use T3-managed worktree isolation for delegated implementation. Follow [AGENTS.md](../../../AGENTS.md) and implement through existing entry points. Reproduce a bug at its owning layer and capture visual changes before and after. Use isolated development profiles, synthetic mail, or provider fakes. Follow AMC's [send boundary](../../../docs/adr/0001-agents-cannot-send-by-construction.md) and [feedback privacy rules](../amc-feedback/SKILL.md#private-feedback-evidence).

Run focused checks while iterating. Review the diff against the expected behavior, including callers and superseded code. For an unsettled UX or architecture decision, have a fresh agent challenge the proposed behavior or boundaries before edits. Independently verify those changes and any work where correctness hinges on state, permissions, recovery, or delivery. Give the reviewer the commit, expected behavior, relevant files, existing evidence, and a specific failure mode to investigate. Ask for material findings and rerun checks when findings change the code or expose a gap in the evidence. If a fresh reviewer is unavailable, record that and check the risk directly.

## 3. Push, merge, and report

1. Commit scoped changes and push from a clean macOS worktree with the [pre-push hook](../../../docs/runbook.md#local-verification) active. Use the hook for the full `pnpm verify` pass on the outgoing commit.
2. Append the verified SHA and check results to the thread record. Open or reuse the PR and resolve outstanding reviews. If the PR head changes, review and verify the new commit locally. Merge the verified head and confirm the PR state.
3. Stop task-owned processes and remove disposable scratch files, profiles, and generated artifacts after capturing their evidence. Preserve worktrees and branches with active or unique work. Use T3's workspace lifecycle for disposable managed worktrees.
4. Complete Todos from observed results. Report the PR, verification, merge state, and installation status when relevant. Follow the [runbook](../../../docs/runbook.md) for requested deployment.

An implementation request authorizes this sequence by default. Honor an explicit stop or handoff and repository enforcement. Record any external approval or missing fact that blocks progress and the smallest action that resolves it.
