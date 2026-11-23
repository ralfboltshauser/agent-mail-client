---
name: amc-release
description: Cut a new AMC release from merged changes, deploy it to the Mac and Ubuntu Engine, and retire eligible local worktrees. Use for explicit AMC release, resume, or release dry-run requests.
---

# Release AMC

Run this from an AMC checkout on the Apple silicon release Mac. [Release setup](../../../docs/runbook.md#release-amc) covers the private SSH config, signing, and recovery.

1. Run `pnpm release --dry-run`. Read the proposed version and commit. The runner gets the source from GitHub's default branch and compares remote tags and releases, so unmerged branches never enter a build. An unpublished version tag means resume its exact commit, even when new changes have landed on the default branch.
2. For a release or resume request, run `pnpm release` and follow the command through completion. An explicit release request authorizes the tag, release notes, and updates to the configured installations. For a plan or dry run, stop after step 1.
3. On failure, identify the failed stage. Fix a recoverable precondition and rerun the same command. A pushed tag is the resume checkpoint. Never move or delete it to retry. If activation reports that the previous Engine failed to recover, follow the [rollback runbook](../../../docs/runbook.md#rolling-back). Keep database restoration subject to the owner's authorization because it can erase writes.
4. Let the runner handle cleanup. The private retirement list is for standalone detached checkouts whose owners have released them. Git merge ancestry verifies that their commits are already on the default branch. Leave linked branches and T3-owned workspaces to their owners or T3's lifecycle controls. Never infer retirement from a clean Git status, old timestamp, or merged PR alone.
5. Report the version, commit, GitHub release link, local disk image, target verification, and what was retired or preserved. If publication is pending, report which targets actually updated. Keep SSH aliases and local configuration out of release notes, commits, and issue or PR text.
