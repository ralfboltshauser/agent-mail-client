---
name: amc-triage
description: Review the AMC inbox, decide which mail needs the owner's attention, identify replies and follow-ups, and propose inbox cleanup.
---

# Triage AMC mail

1. Read the user's mail playbook if it exists at `${XDG_CONFIG_HOME:-$HOME/.config}/amc/mail-playbook.md`. Apply confirmed rules there. Treat individual prior decisions as examples for those threads. Suggest a new rule with its evidence for the owner to confirm.
2. Choose access using `use-amc`. In a paired owner session, `amc triage queue --json` shows new senders and uncertain classifications. For “what do I owe?” or “what needs my attention?”, inspect the Inbox across read and unread threads with MCP `list_threads` or `threads --json` on the authorized CLI invocation. The review queue covers a subset, and reading a message leaves its obligations open. Report the accounts and range reviewed. A capped list or a timestamp-paged scan can omit threads, including ties at page boundaries, so describe findings from the threads you reviewed and qualify any claim of completeness.
3. Read the relevant threads using `use-amc`. For each, find the latest substantive message and establish who owes the next move and when. Classify it as **Reply** if the owner owes a response, **Action** if the owner needs to do something, or **Follow-up** if the thread needs revisiting later. Use **Update** for useful information, **Later** for worthwhile deferred reading, and **When I have time** for optional reading. Surface uncertain next steps and missing deadlines as such.
4. Assess Inbox placement separately from the Bucket. Preserve visible access to suspected security, account, billing, deadline, or obligation mail. A sender rule affects future arrivals on that account, so surface the exact address and account before changing one.
5. Return the next action, who owes it, any established deadline, and its AMC thread ID. Put time-sensitive items first. For review requests, report proposed changes. When the user requests a write, use the granted tool for that exact action and target. If the scoped grant lacks the write tool, report the gap. The paired CLI runs with owner privileges, and `amc triage` without a subcommand or `--dry-run` can change Buckets. Check command help before a write and report pending, partial, and confirmed outcomes distinctly.
