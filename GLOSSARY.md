# Agent Mail Client

A self-hosted, agent-native mail client: one person's mail, worked on by that person and their agents side by side.

## Language

### Places

**Host**:
The always-on machine the owner controls, where the Engine runs.
_Avoid_: server, backend, cloud

**Engine**:
The headless core that holds the owner's mail and is the single source of truth for it.
_Avoid_: backend, daemon, sync service

**Client**:
Anything that works on mail through the Engine: the desktop app, the Android app, or an Agent.
_Avoid_: frontend, app (when an Agent is meant too)

### Mail

**Account**:
One mailbox the owner has at a mail provider (a Google account or an IMAP/SMTP mailbox).
_Avoid_: inbox, user, identity

**Unified Inbox**:
The single view of incoming mail across all Accounts.
_Avoid_: all inboxes, combined inbox

**Thread**:
A conversation: the messages that belong to one exchange, shown as one unit.
_Avoid_: conversation, chain

### Agents and attention

**Agent**:
An AI Client acting on the owner's mail on the owner's behalf.
_Avoid_: bot, assistant, AI

**Harness**:
The coding-agent runtime the owner already has installed and logged in on the Host (Claude Code, Codex), through which every Agent runs.
_Avoid_: LLM provider, model, API

**Interrupt**:
A notification that reaches the owner's attention immediately; mail that is not Interrupt-worthy arrives silently.
_Avoid_: alert, ping, push (when the decision rather than the delivery is meant)

**Dangerously Allow Send**:
The explicit owner setting without which no Agent has any means of sending mail.
_Avoid_: auto-send, send permission
