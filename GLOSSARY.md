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

**Label**:
A tag on a Thread; the one organising concept across all Accounts (an IMAP folder appears as a Label, and on IMAP a message can carry only one).
_Avoid_: folder, tag, category

**Archive**:
Removing a Thread from the Inbox without deleting it; what "done" means in AMC.
_Avoid_: done, file away, mark done

**Snooze**:
Hiding a Thread until a chosen time or until a condition (such as no reply arriving), then returning it to the Inbox.
_Avoid_: remind me, defer

**Mute**:
A Thread state in which new replies skip both the Inbox and Interrupts.
_Avoid_: ignore, silence

**Bucket**:
The one place triage puts a Thread based on how the owner will handle it. A Thread can go in Reply, Action, Follow-up, Update, Later, When I have time, or Newsletters.
_Avoid_: category, priority, folder

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

**Quiet**:
The view of mail that arrived without an Interrupt, so that nothing is ever hidden from the owner.
_Avoid_: other, low priority, filtered

**Agent Draft**:
A reply written by an Agent and waiting for the owner; sending it always takes the owner's action unless Dangerously Allow Send is on.
_Avoid_: suggestion, auto-reply

**Dangerously Allow Send**:
The explicit owner setting without which no Agent has any means of sending mail.
_Avoid_: auto-send, send permission

**Handoff**:
Giving a Thread to an Agent working in one of the owner's projects, so that it drafts the reply with that project's context.
_Avoid_: delegate, forward to AI

**Composer Link**:
A link that opens one draft for live editing by the owner and an Agent together, and can do nothing else (it can never send).
_Avoid_: share link, draft URL

### Smart Inbox

**Sender**

The parsed From mailbox of an incoming message. Screening uses its full address within an Account.

**Sender rule**

An owner's explicit decision to accept or block a Sender for one Account.

**Known sender**

A Sender the owner has accepted, sent mail to, or replied to on that Account. A block takes precedence over prior outbound mail.

**Screened out**

The recoverable AMC Label where blocked Senders' incoming messages go. Gmail uses a user Label. IMAP uses a folder.

**Filtered**:

The recoverable AMC Label for incoming mail omitted from Inbox by an owner choice or an approved Preference rule.

**Filter out**:

The choice to place incoming mail in Filtered. Press **!** (Shift+1) in the desktop Thread list or reader, or **F** in Triage. **F** opens Forward in the Thread list and reader.

**Section**

A named group of Threads or Sender cards within the Inbox.

**Triage queue**

The ordered set of New sender cards and low-confidence Threads waiting for review in a triage session.

**Confidence**

A triage assessment of how certain a prediction is for the current incoming mail.

**Triage correction**

An owner's explicit replacement or confirmation of a triage judgment.

### Owner preferences

**Decision label**:

A stable judgment value within one triage dimension, such as Keep in Inbox within filtering.
_Avoid_: provider Label

**Triage decision**:

An explicit owner judgment about an arrival, Thread or Sender, optionally with a reason.
_Avoid_: prediction, move result

**Triage prediction**:

AMC's assessment of an arrival against a triage dimension.
_Avoid_: owner decision

**Decision log**:

The ordered history of Triage decisions, Triage predictions and their amendments.

**Preference rule**:

An owner-editable plain-language instruction for how AMC should assess a kind of mail.

**Preference policy**:

A versioned set of Preference rules for an Account. The active version is the version the owner approved for use.

**Shadow policy**:

A Preference policy evaluated on arrivals to preview its judgments before activation.

### Observability

**Request ID**

An opaque UUID joining one Engine HTTP request, its response, and the Client's local failure details.

**Run ID**

An opaque UUID shared by the stages and retries of a logical operation, such as a triage run or sync cycle.

**Span**

A timed operation within a Run, with start, finish and outcome records.
