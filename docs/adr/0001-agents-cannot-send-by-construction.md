# Agents cannot send mail unless Dangerously Allow Send is on

Agent sends are irreversible. Unattended jobs never get Send. An interactive Agent can discover and invoke Send only while **Dangerously Allow Send** is on and its scoped grant is live. The Engine also requires a single-use desktop owner approval for the exact Account, draft version and recipient envelope. The gate applies at execution and provider dispatch. Disabling the setting invalidates affected live Harness sessions and grants. [M6 permissions](../agents/permissions.md)
