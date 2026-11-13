# Agents cannot send mail unless Dangerously Allow Send is on

Agents may do anything reversible (label, archive, snooze, draft) but sending is irreversible and is where trust is lost. So the send tool is not exposed to Agents at all — not via MCP, CLI, or the in-app Harness — unless the owner turns on **Dangerously Allow Send**. This is enforced by tool exposure, not by prompting or agent behaviour: a misbehaving or prompt-injected agent cannot send because the capability does not exist for it.
