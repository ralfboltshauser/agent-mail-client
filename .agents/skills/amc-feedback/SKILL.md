---
name: amc-feedback
description: Triage AMC's Send Feedback shortcut or messages marked "AMC feedback" or "feedback:" about AMC. Read local evidence and hand a sanitized brief to amc-work.
---

# AMC feedback

1. Confirm the desired behavior from the owner's text and any annotations. If the capture has no request or usable annotation, wait for the owner to add details. Split unrelated requests so each can be researched, built and verified independently.
2. Inspect the screenshot or its original local PNG in place. Use the context block for the version, view and capture time. If there is a log excerpt, read it locally and match relevant warnings to that time. Follow a run or request ID with `amc logs --run <id>` or `amc logs --request <id>` on the machine that owns the logs when it helps explain the behavior. If the excerpt has expired, continue from the remaining evidence.
3. Record the symptom and expected behavior using synthetic examples. Use that brief to start the [amc-work](../amc-work/SKILL.md) triage Todo and extend the same record through delivery. Treat actionable change feedback as a build request unless the owner asks to investigate or defer it.

If the owner supplies a snapshot from **Help → Copy Diagnostics** or the command palette, check its versions, Desktop sync state, health warning codes, Engine diagnostic status and recent local warnings. Apply the same external-report limits as for the local excerpt.

## Private feedback evidence

Screenshots, annotations and logs can contain real mail. Keep original captures and raw excerpts local and under AMC's retention policy. Use a sanitized brief in searches, delegate prompts, issues, PRs, branch names, fixtures and logs. Describe the UI and behavior without real senders, addresses, subjects or bodies. Share a local capture path only with a local delegate that needs to inspect it. Include only the relevant event, error class and correlation ID when sharing diagnostic evidence externally.

Reply in the feedback thread with the outcome, the linked work if any, and anything the owner needs to try or decide.
