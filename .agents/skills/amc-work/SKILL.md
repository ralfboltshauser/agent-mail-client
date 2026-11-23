---
name: amc-work
description: Run AMC bug fixes, UI polish, UX changes, and new capabilities as native T3 Todos. Use for direct implementation requests and sanitized AMC feedback. Research and reuse, implement in an isolated worktree, review, verify, and merge autonomously.
---

# AMC work

## 1. Triage and register Todos

Call `update_plan` with **Triage request and check existing work** in progress. Use the provider's native task tool if it exposes a different one. If none is available, use a short checklist in the thread. Keep the plan current as steps start, finish or become blocked.

Identify the desired outcome and search existing code, open issues and PRs using feature or component terms. Check closed work if the report sounds like a regression. Link a known duplicate in the thread and carry forward any new evidence when asked to update the existing work. Answer questions in place. For deferred work, record the sanitized scope, outcome, evidence and proposed route in the T3 thread, or file it at the destination the owner requests. Register the build checklist and begin execution when asked to build.

Choose by the actual change:

| Kind | How to recognize it | Use this route to shape the Todos |
| --- | --- | --- |
| Bug or regression | Existing behavior breaks or differs from the intended contract | Reproduce at the owning layer and trace the cause. Compare how other projects handle the same failure mode. Fix and rerun the reproduction and relevant tests. |
| UI polish | The intended behavior is known and the change brings it into line with a pattern | Compare AMC surfaces and an external example or guideline. Reuse the existing component, token or interaction convention. Capture the before and after with synthetic mail. |
| UX change | The change requires deciding how an interaction or flow should behave | Compare working examples and plausible options. Write a plan with the relevant AMC patterns. Have a fresh agent challenge the research and reuse assumptions. Implement and exercise the interaction. |
| New capability | AMC needs a behavior it does not currently expose | Research how comparable tools model and deliver it. Define the smallest useful outcome and trace affected state and entry points. Implement and verify through those entry points. |

Size depends on the scope of the contracts and proof needed. For changes crossing an app or process boundary, moving state ownership, changing persisted data or permissions, or requiring multiple independently testable slices, add a **Map and review architecture** Todo before implementation and read [the C4 guide](architecture.md). Split large work into independently verifiable slices with explicit dependencies. Open child issues or assign a milestone when the owner asks to record that breakdown in GitHub.

When implementation is requested, keep the completed triage item and register the whole checklist in one update. Include reproduction or a before capture when useful, **Research comparable solutions and inspect AMC for reuse**, any architecture or plan review, **Prepare isolated worktree**, implementation, **Review and verify the change**, **Push and merge the verified PR**, and **Clean up the code and workspace**. Fold the route's research questions into the research Todo. Use concrete labels such as **Verify archive focus with synthetic mail** so progress is legible in T3.

## 2. Research and decide what to reuse

Complete research on all four routes before making production edits. Scale the research to the decision. One focused example or official guideline usually suffices for a straightforward fix or polish pass. For UX choices, new capabilities and architectural changes, compare at least two relevant approaches when evidence is available.

- **Online:** Inspect firsthand sources such as the upstream implementation, product docs, an actual interaction, a spec, or a maintainer's write-up. Capture what each source actually demonstrates, the tradeoff it reveals, and what applies to AMC. Use generic search terms and synthetic scenarios. If direct evidence is unavailable, record the search and the uncertainty so the recommendation does not depend on a guess.
- **In AMC:** Trace the current entry point to the owner of the behavior and state. Read existing callers, tests, fixtures, and applicable specs or ADRs. Name the specific code to reuse or extend and what would have to change for it to fit. If a parallel implementation or new abstraction seems necessary, explain the gap and consider whether consolidating with existing code would preserve caller behavior.
- **Decision:** Record the chosen behavior, the evidence behind it, and what will verify it. Finish with the applicable source links, code paths and acceptance criteria in the T3 thread or the linked issue. Only keep a standalone artifact when it carries a durable design or architecture decision.

Delegate bounded, read-only research when the comparison or repo trace would fill the main thread, or when independent checks can run in parallel. Give delegates a narrow question and ask for links or file references, a short finding, and unresolved uncertainties. Synthesize and check the decisive claims yourself. On the UX route, use a fresh subagent to test the proposed plan against the existing code and external evidence before edits. For architectural work, ask it to challenge the current and proposed ownership and boundaries as well. If a fresh agent is unavailable, record that and perform the check directly. Keep small fixes in the main thread.

## 3. Implement, verify, and merge

1. Before editing, reuse this task's isolated worktree or create a fresh one from the current target branch. Use T3-managed worktree isolation for delegated implementation. If implementing directly from the shared checkout, create a separate Git worktree and do the edits and checks there. Keep the original checkout and existing work intact.
2. Implement through existing entry points and follow [AGENTS.md](../../../AGENTS.md). For delegated work, hand over the decision, acceptance criteria, and relevant sources. Use an isolated development profile, synthetic mail or provider fakes, and follow AMC's [send boundary](../../../docs/adr/0001-agents-cannot-send-by-construction.md) and [feedback privacy rules](../amc-feedback/SKILL.md#private-feedback-evidence).
3. Review the actual diff against the acceptance criteria, check cleanup of superseded code, and run the relevant verification. Use a fresh verifier for UX or architecture changes and work where correctness hinges on state, permissions, recovery or delivery. Resolve blocking findings and reverify the affected behavior. Record the reviewed commit and test evidence.
4. Commit scoped changes, push the branch, and open or reuse its PR. Check CI and outstanding reviews for the current PR head. If a check is pending, use the T3 PR watch to resume when it finishes. Investigate failures and address blocking findings. If the head changes, review and verify the new head before merging. Merge the verified head and confirm the PR is merged before completing the Todo.

The implementation request authorizes this sequence by default. Make routine decisions from the evidence and proceed without requesting owner approval. Follow any explicit stop or handoff in the request and honor repository enforcement. If an external approval or missing fact genuinely prevents safe completion, record the blocker and the smallest action that unblocks it. Follow the current [runbook](../../../docs/runbook.md) when deployment is requested.

## 4. Clean up and report

Before completion, check both parts of **Clean up the code and workspace**:

- **Code:** Review the diff for superseded paths, orphaned imports or dependencies, duplicate helpers, obsolete comments, temporary logging and ad hoc fixtures. Confirm callers before removing code. Preserve intentional tests and design evidence. Rerun affected checks if cleanup changes the verified code.
- **Workspace:** Stop only processes started for this task. Remove task-owned disposable scratch files, temporary profiles and generated artifacts once their useful evidence is captured. Preserve existing changes and any worktree or branch that still backs a PR, an active task or unique work. Use T3's workspace lifecycle for disposable managed worktrees once their work is safely recorded.

Mark Todos complete from observed results. Report the merged PR, verification evidence and any remaining blocker or evidence gap.
