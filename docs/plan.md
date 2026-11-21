# AMC v1 build plan (Mac + Host)

Status: **accepted** (2026-11-20). The owner said build it. The recommended defaults stand for the open decisions in §11, and the review fixes are folded in.
Scope: everything in AMC v1 ([What exactly is in AMC v1?](https://github.com/ralfboltshauser/agent-mail-client/issues/8)) **except the Android app**, which comes after this plan. Terms follow [GLOSSARY.md](../GLOSSARY.md). ADR [0001](adr/0001-agents-cannot-send-by-construction.md) (Agents cannot send) and ADR [0002](adr/0002-agents-run-through-the-owners-harness.md) (Agents run through the installed CLIs) hold throughout.

**Done means:** Ralf runs all four Accounts in AMC on the Mac for two weeks without opening Spark on the Mac. Until the Android app exists, the phone keeps a stock mail app for reading.

---

## 1. Shape

```
                       Tailscale (tailnet only, HTTPS via `tailscale serve`)
 ┌──────────── Mac ─────────────┐            ┌──────────────── Host: ralfs-ubuntu ────────────────┐
 │ AMC desktop (Electron)        │  sync API  │ Engine (Node, system user `amc`, systemd)           │
 │  main: replica (SQLite),      │◀──────────▶│  provider connectors: Gmail API, IMAP (imapflow),   │
 │        sync client, keychain  │  WebSocket │                       SMTP (Nodemailer)             │
 │  renderer: React + shadcn     │            │  store: SQLite (NVMe) + blobs (/srv HDD)            │
 │                               │            │  sync: change log, mutation queue, writeback        │
 │ T3 Code / Codex / Claude ─────┼── MCP ────▶│  agent API: MCP + `amc` CLI, scoped tokens          │
 │                               │            │ Agent runner (user `ralf`): installed claude/codex  │
 │   side panel ─ composer link ─┼── WS ─────▶│  composer: Yjs docs (Hocuspocus)                    │
 └───────────────────────────────┘            │  agent runner: installed `claude` / `codex`         │
                                              │  scheduler: snooze, send-later, triage, backups     │
                                              └─────────────────────────────────────────────────────┘
```

- The **Engine** is the single source of truth. Every **Client** (the desktop app, the `amc` CLI, Agents over MCP, a composer link) works through its API. No Client talks to Gmail or IMAP directly.
- The **desktop app** keeps a local **replica**, so every read and every action is local and instant. It syncs with the Engine in the background.
- **Agents** never see more than their token allows. Unattended Agents have no send tool. Interactive Agent sends require the [M6 send gate](agents/permissions.md#dangerously-allow-send).
- **The Engine runs as its own system user, `amc`** ([ADR 0003](adr/0003-engine-runs-as-its-own-user.md)). Its tokens, key and mail are unreadable to anything running as `ralf`, including T3 Code and Codex agents with full shell access. Only the agent runner runs as `ralf`, because it needs the owner's Claude and Codex logins (ADR 0002), and it reaches mail only through MCP.

## 2. Stack

| Area | Choice | Why |
|---|---|---|
| Language | TypeScript everywhere, `pnpm` workspaces | One language for Engine, desktop and shared protocol; the Host already has Node 26 and pnpm |
| Engine runtime | Node 26, Hono (HTTP), `ws` (WebSocket) | Stable, all mail libraries are Node-first |
| Engine store | SQLite via `better-sqlite3`, WAL, FTS5 | One file, fast, full-text search built in, trivial backups |
| Gmail | `googleapis` Gmail API: `history.list`, `messages.get`, `modify`, `drafts`, `send` | Research ticket #3 |
| IMAP / SMTP | `imapflow` (IDLE, CONDSTORE/QRESYNC), `nodemailer` | Research ticket #3 |
| MIME | `postal-mime` (parse), `nodemailer` MailComposer (build) | Small, permissive licences |
| Desktop shell | **Electron** via `electron-vite` | Shares TypeScript with the Engine; `better-sqlite3` in the main process; mature notifications, menus, global shortcuts, Keychain. T3 Code ships the same way |
| Desktop UI | React 19, Tailwind v4, **shadcn/ui** (Sidebar, Command, Resizable, Sonner, Dialog), TanStack Virtual, `cmdk` | The shadcn sidebar look Ralf wants; virtual lists for 100k+ Threads |
| Composer | TipTap (ProseMirror) + Yjs, served by Hocuspocus | Rich text, live co-editing between owner and Agent, change attribution for "what changed" |
| Mail HTML | Sandboxed `iframe`, DOMPurify, strict CSP, remote images off by default and proxied by the Engine when allowed | Safety and tracking-pixel blocking |
| Agents | MCP TypeScript SDK (streamable HTTP), Claude Agent SDK pointed at the installed `claude`, `codex app-server` | ADR 0001, ADR 0002 |
| Tests | Vitest; Gmail fake; Dovecot/GreenMail in Docker for IMAP; Playwright for Electron | Writeback bugs are the scary ones |

**Not shadcn + Vercel UI SDK:** the UI SDK exposes on-screen controls to Agents, which would put a Send button in an Agent's reach and break ADR 0001.

## 3. Repository layout

```
apps/engine        Engine service (Host)
apps/desktop       Electron app (Mac): main/ (replica, sync, keychain), renderer/ (React + shadcn)
apps/cli           `amc` CLI (owner and Agents)
packages/protocol  zod schemas: entities, sync API, mutations, MCP tool shapes
packages/mail      MIME parse/build, threading, HTML sanitising, address handling
packages/sync      replica apply + optimistic mutation queue (used by desktop and CLI)
packages/composer  TipTap + Yjs editor shared by desktop and the composer page
packages/ui        shadcn components and the AMC theme
docs/              plan, ADRs, runbooks
```

## 4. Engine

### 4.1 Data model (SQLite)

- `account`: kind (`gmail` | `imap`), address, display name, encrypted credentials, provider sync cursor (Gmail `historyId`; IMAP per-folder `UIDVALIDITY`/`HIGHESTMODSEQ`), health.
- `thread`: Account, provider thread id, subject, participants, last date, unread count, Label ids, triage fields (Bucket, reason, summary, Interrupt), snoozed until, muted, `modseq`.
- `message`: provider id(s), `Message-ID`, `In-Reply-To`, `References`, from/to/cc/bcc, date, snippet, plain text body, HTML body blob ref, flags, size, `modseq`.
- `label`: provider id, name, system or user, colour. `message_label` join.
- `attachment`: name, type, size, content id, blob ref, fetched yes or no.
- `draft`: Account, Thread (optional), headers, Yjs state, provider draft id, last author (owner or Agent), `modseq`.
- `outbox`: draft snapshot, send at, undo until, status, provider message id.
- `contact`: address, name, last seen, frequency (built from mail; feeds autocomplete and Agents).
- `change_log`: global monotonic `modseq`, entity, id, op. Drives sync.
- `mutation`: client-generated id, kind, args, status, error. Makes every change idempotent.
- `agent_action`: Agent, tool, arguments, before and after, undone. Shown and undoable in the desktop app.
- `fts_message`: FTS5 index over subject, participants, body text, attachment names.

Threading: Gmail Threads come from Gmail. IMAP Threads use `References`/`In-Reply-To` (JWZ), with a subject fallback inside a short time window.

### 4.2 Storage on the Host

The root NVMe disk is at **97%** (7.5 GB free), and `/srv` is a 1.8 TB spinning disk with 1.3 TB free.

- **Everything under `/srv/amc`** (owner `amc`, mode 700) until the root disk has room:
  - `db/amc.db`: the SQLite database and FTS index. It holds metadata and text for the entire history across all four Accounts. Expect a few GB up to roughly 20 GB. With 45 GB of RAM it is mostly in page cache, so the spinning disk is acceptable.
  - `blobs/`: raw MIME, HTML bodies and attachments in a content-addressed store.
- **The database moves to NVMe** at `/var/lib/amc` once the root disk has at least 30 GB free. It's a one-line config change.
- **Secrets** go in `/etc/amc` (owner `amc`, mode 700): the Google OAuth client and the encryption key.
- **Blobs are a cache.** They can be fetched from the provider again, so they are not backed up. The database holds the data only AMC has (Buckets, Snoozes, drafts, the agent log), so that is what gets backed up.
- Attachments are fetched lazily on first open, then kept.
- Freeing the root disk is Ralf's call: Docker build cache, `.microsandbox` (49 GB), `~/.cache` (14 GB). Nothing of his is deleted by the build.

### 4.3 Provider sync

- **Backfill:** the entire history, newest first, resumable, rate-limited, using Gmail batch requests (about 30–60 minutes per 100k messages). The inbox and the last 90 days come first so the app is usable within minutes, and older mail streams in behind.
- **Gmail incremental:** `history.list` from the last `historyId`, polled every 15 seconds per Account. A Pub/Sub watch for instant delivery is an optional switch (it needs billing on the Cloud project). On a `historyId` too old, fall back to a full resync.
- **IMAP incremental:** IDLE on INBOX, and CONDSTORE/QRESYNC on every folder every few minutes. Without those extensions, UID-range diffs (see the IMAP extensions ticket).
- **IMAP parser memory follow-up.** Raw MIME and attachments stream to disk. MailParser retains decoded plain text and HTML in memory. Bound memory for very large bodies while preserving complete message display.
- **Label mapping:** Gmail labels map 1:1. IMAP folders map to Labels, so a message carries at most one. Special-use folders (`\Archive`, `\Sent`, `\Trash`, `\Drafts`) map to the system Labels.

### 4.4 Mutations and writeback

1. A Client sends `POST /mutations` with a batch of `{id, kind, args}` (archive, label, read, star, trash, snooze, mute, draft edits, send).
2. The Engine applies the batch locally in one transaction. That bumps `modseq` and logs the changes, so every other Client sees the result at once.
3. The per-Account queue writes one Gmail message at a time and reads the current labels before each write or retry. The write contains only the labels whose values still match the mutation's baseline.
4. If Gmail permanently refuses a message, the queue continues with the other messages. The Engine reads Gmail again and replaces the optimistic projection with the provider's labels. Successful Gmail writes stay in place.
5. A partial result reports the applied, superseded, and failed labels by message. The desktop shows the count and offers Undo for acknowledged changes. Undo is a user action that checks current Gmail labels and inverts only acknowledged deltas that still match. A change to one label leaves the outcome for other labels on the same message intact.

Before dispatch, the Engine records the requested delta and the message's Gmail history ID. If the response could have been lost after Gmail committed the write, the queue reads again before any retry. A matching history ID permits a retry. If the history ID changed or is unavailable, the Engine leaves the uncertain labels alone and excludes them from Undo because Gmail cannot attribute the change to AMC.

Gmail has no conditional write for labels. The final read leaves a window in which the owner can edit the same label before dispatch. The write targets only explicit message IDs. A reply delivered after Archive's final read keeps its Inbox label and enters the replica through history sync. Trash adds the TRASH label and hides the message from Inbox. Untrash removes TRASH so the underlying Inbox membership becomes visible again.

### 4.5 Sending

- **Gmail:** `users.messages.send` with the right `threadId`, `In-Reply-To` and `References`.
- **IMAP Accounts:** SMTP through Nodemailer, then `APPEND` to the Sent folder unless the provider does that itself.
- **Who can send:** the Engine authorizes the owner send path and applies the separate [M6 send gate](agents/permissions.md#dangerously-allow-send) to interactive Agents.

## 5. Sync protocol (Engine ↔ desktop)

JMAP-style "changes since state X" over one global `modseq`. This was the top pick in [the local-first sync research](https://github.com/ralfboltshauser/agent-mail-client/issues/5).

- **Bootstrap:** a new replica first records the current `modseq`, then pages through a **snapshot** of the tables (`GET /sync/snapshot?at=<modseq>&cursor=…`), newest Threads first, so the inbox appears first. Then it follows changes from that `modseq`.
- **Change log retention:** the change log is pruned after 30 days. A client asking for changes older than the oldest kept entry gets `resync_required`, then bootstraps again. This is JMAP's `cannotCalculateChanges`.
- **Live:** a WebSocket sends `{modseq}` nudges. The client pulls `GET /sync/changes?since=<its modseq>`.
- **Writes:** the client applies a mutation optimistically to an overlay on the replica and queues it (durably, so it survives restarts and offline time). When the Engine's change carrying that mutation id comes back, the overlay entry is dropped. On error, the overlay is rolled back and a toast explains why.
- **Replica scope:** metadata for every Thread, plus bodies for the last 12 months and every unarchived, starred or draft Thread. Older bodies come from the Engine on open and are then cached.
- **Search:** typing filters the replica instantly. In parallel, the query goes to the Engine's FTS5 index over the entire history, and the results are merged.
- **Budgets:** any keyboard action under 50 ms to a visible result. A 60 fps list at 100k Threads. New mail on the Mac within 20 seconds with polling, or within 5 seconds with Pub/Sub or IDLE.

## 6. Security and principals

- The Engine listens on `127.0.0.1` only. `tailscale serve` exposes it over HTTPS to the tailnet. It is never on the public internet. The Engine also checks the `Tailscale-User-Login` header that `tailscale serve` adds, so a leaked token alone isn't enough from another device.
- **The Engine runs as system user `amc`.** Its data and secrets are readable by no one else (ADR 0003). The owner token on the Mac sits in the Keychain, restricted to the AMC app.
- **Principals and tokens:**
  - **Owner device:** the desktop app, paired once with a code shown by `amc pair`. Its token lives in the macOS Keychain. It can do everything, including sending.
  - **Agent token:** in M6, bound to an owner-approved job with explicit operations, Accounts, targets and expiry. [M6 permissions](agents/permissions.md)
  - **Composer link:** a capability token for one draft, edit only, expiring after two hours. It cannot send, list or read other mail.
- **Dangerously Allow Send:** toggled only in the desktop app, behind a confirmation. Every send by an Agent is logged, and turning the setting on is announced in a notification.
- **Provider credentials** (OAuth refresh tokens, IMAP passwords) are encrypted at rest with a key in `~/.config/amc/key` (mode 600). The Google OAuth client is already at `~/.config/amc/google-oauth-client.json`.
- **Tests:** a test suite proves ADR 0001 by listing MCP tools for every scope combination with the setting off and asserting there is no send tool and no send route.

## 7. Agents

### 7.1 Agent API
- An MCP server over streamable HTTP at `/mcp`.
- **Read tools:** `list_threads` (by Bucket, Label, query), `get_thread`, `search`, `search_contacts`, `get_attachment_text`.
- **Organize tools:** `set_triage`, `archive`, `label`, `snooze`, `mute`, `mark_read`.
- **Draft tools:** `create_draft`, `read_draft`, `update_draft`, `comment_on_draft` (questions for the owner), `composer_link`.
- **Send:** `send_draft` is exposed only to interactive Agents with a live send grant and Dangerously Allow Send on. Each send also needs exact-draft owner approval.
- **`amc` CLI:** the same surface for scripts and Agents that prefer a shell.
- **Undo:** every Agent call is written to `agent_action` and can be undone from the desktop app.

### 7.2 Agent runner (the Engine's own Agents)
- The Claude Agent SDK and Codex app-server share the owner's existing login under ADR 0002. The runner uses a private MCP forwarder per run. Each adapter stays off until its [inventory](agents/headless.md#adapter-activation) and [Host confinement checks](agents/sandbox.md#before-enabling-either-adapter) pass.
- Runs are queued and limited to two at a time, with a time limit per run. Their output is only ever MCP calls.

### 7.3 Triage
- New Threads (and new messages in non-muted Threads) are batched every 30 seconds and given to the triage Agent. Only new mail and the current inbox are triaged, never the backfilled history.
- **Cost:** triage spends the owner's Claude and Codex limits, so it uses the smallest model that sorts well, is capped at a set number of runs per hour, and reports its usage on the health page.
- It sets one **Bucket**, a one-line reason, a short summary and whether the Thread is Interrupt-worthy (rules from [What makes a message Interrupt-worthy?](https://github.com/ralfboltshauser/agent-mail-client/issues/10)).
- When Ralf moves a Thread to another Bucket, that's a correction. Corrections are kept as examples in the triage prompt, so triage learns his taste.
- Interrupt-worthy Threads notify the Mac with the reason. Everything else arrives silently and stays visible.

### 7.4 Handoff and the live composer
From [How does the owner hand a Thread to an Agent and iterate on the reply together?](https://github.com/ralfboltshauser/agent-mail-client/issues/17):
- **Hand off** (key `H`): pick a project (T3 projects if [the T3 research](https://github.com/ralfboltshauser/agent-mail-client/issues/18) says AMC can list them; otherwise a configured list of project folders), then choose:
  - **Copy prompt:** for any agent app. Contains the Thread id, the composer link and MCP setup.
  - **Open in T3:** starts or continues a T3 thread in that project, if T3 allows it.
  - **Run here:** an Engine Agent with that project folder as its working directory, read-only.
- **Composer page:** served by the Engine at a composer link and opened in T3's side panel or any browser. It's the same TipTap + Yjs editor as the desktop app. The Agent's `update_draft` calls become Yjs edits attributed to the Agent, so they appear live. Ralf's typing syncs straight back. **There is no Send button on this page.**
- **What changed:** the draft highlights everything changed since Ralf last looked, so he rereads only that.
- **Select and revise:** select text, type or dictate an instruction, and the Agent rewrites just that span. It goes to the linked T3 thread when there is one, otherwise to an Engine Agent with the Thread and draft as context.
- Agent questions from `comment_on_draft` show next to the draft.
- **Drafts and Gmail:** AMC's draft (the Yjs document) is the master copy. It's pushed to the provider's drafts every few seconds while it changes, so the draft is visible in Gmail too. An edit made in Gmail is taken in only if AMC's copy hasn't changed since the last push. Otherwise AMC keeps both versions and flags the conflict.
- **Later:** suggest the project from past handoffs by sender and domain, then pre-draft replies for the Reply Bucket before Ralf opens them.

## 8. Desktop app

- **Layout:** a shadcn inset Sidebar, a virtual Thread list, and a reading pane, in resizable panels.
- **Sidebar:**
  - Account switcher: Unified, or one Account.
  - Buckets with counts: Reply, Action, Follow-up, Update, Later, When I have time.
  - Quiet, Snoozed, Drafts, Sent, Labels.
  - Sync status per Account, at the bottom.
- **Keyboard first:** everything in a ⌘K command palette.
  - Movement and views: `j`/`k` move, `↵` open, `e` archive, `#` trash, `l` label, `b` snooze, `m` mute, `s` star, `u` toggle read.
  - Compose: `r`/`a`/`f` reply, reply-all, forward. `c` compose. `⌘↵` send.
  - Navigate: `/` search, `g` then `i`/`d`/`s` go to a view.
  - Agents: `H` hand off, `z` undo.
  - Shortcuts are shown in the menus and the palette.
- **Reading:** Thread view with collapsed history, sanitised HTML in a sandboxed iframe, a remote-images toggle per sender, attachments with Quick Look preview, the Agent summary at the top, and the Bucket reason shown.
- **Compose:** the TipTap composer, recipients with contact autocomplete, attachments by drag-drop or paste, per-Account signatures, send-later, an undo-send toast, and the same live Agent drafting as the composer page.
- **Notifications:** native macOS notifications for Interrupts only, showing the reason. The Dock badge shows the Reply Bucket count. AMC starts at login and keeps running in the menu bar when its window is closed, so notifications arrive.
- **Mail views:** a one-key unsubscribe (`List-Unsubscribe`) for newsletters, read-only display of calendar invites, and one Thread shown once when it lands in two Accounts.
- **Settings:** Accounts (add via a browser OAuth sign-in with a loopback redirect on the Mac; the code goes to the Engine, which exchanges it. Before the desktop app exists, `amc account add gmail` does the same from the CLI), signatures, Agent tokens, Dangerously Allow Send, triage examples, shortcuts.
- **Distribution:** built locally and signed ad hoc for Ralf. Notarisation and auto-update come with polished onboarding, after v1.

## 9. Operations on the Host

- **Services:** `amc-engine.service` is a system service running as user `amc`. `amc-agents.service` is a system-managed service running as `ralf`, with per-run confinement and a trusted forwarder as specified in [ADR 0004](adr/0004-confine-the-agent-runner-on-the-host.md). Both restart on failure and log JSON (pino) to journald.
- **Deploy:** `pnpm deploy:host` (from the Mac) runs, over SSH:
  1. sync the commit into `/opt/amc/releases/<sha>` and point `/opt/amc/current` at it
  2. install and build
  3. run migrations
  4. restart
  5. health check; if it fails, roll back to the previous build
- **Migrations:** numbered SQL files, applied at startup inside a transaction, with a backup taken first.
- **Backups:** nightly `VACUUM INTO` of the database straight to `/srv/backups/amc`, kept 14 days. An offsite copy is still to be decided. A restore drill is part of cutover.
- **Health:** `/health` reports per-Account sync lag, writeback queue depth, the last error and disk headroom. The desktop app shows it and notifies when lag exceeds 10 minutes or a sign-in has expired.
- **Running the Engine on the Mac:** supported for development (`pnpm dev` starts the Engine and the desktop app against a test Account). The Host stays the production Engine.

## 10. Milestones

Each milestone is one GitHub ticket with a checklist and ends with something Ralf can use. The arrows show what each one needs first.

| # | Milestone | Needs | Ralf can then… |
|---|---|---|---|
| M0 | Foundations: monorepo, CI, Host disk freed, `/srv/amc`, systemd unit, `tailscale serve`, deploy script, owner pairing | — | — |
| M1 | Gmail Engine: both Gmail Accounts, OAuth sign-in (via `amc account add`), full backfill, incremental sync, threading, store, FTS | M0 | query his mail with `amc` |
| M1b | MCP read and drafts: `get_thread`, `search`, `list_threads`, `search_contacts`, `create_draft`/`update_draft` as Gmail drafts, agent tokens; no send | M1 | hand Threads to T3 and get real Gmail drafts, weeks before the desktop app |
| M2 | Desktop shell and sync: Electron, replica, sync protocol, shadcn sidebar, list, reading pane, search, palette | M1, UI prototype | read all Gmail in AMC |
| M3 | Organise: mutation pipeline and writeback; archive, trash, read, star, Labels, Snooze, Mute, undo | M2 | triage by hand in AMC |
| M4 | Compose and send: composer (Yjs from day one), reply/forward/new, attachments, signatures, contacts, drafts sync, outbox with send-later and undo-send | M3 | stop using Gmail and Spark for Gmail Accounts |
| M5 | IMAP Accounts: imapflow sync, folders as Labels, SMTP send, Sent append | M1, IMAP extensions check | have all four Accounts in AMC |
| M6 | Agent platform: organize tools, full scopes, ADR 0001 test suite, agent runner, action log with undo, Dangerously Allow Send | M1b, M3, headless proof, sandbox, permission model | let Agents organise his mail safely |
| M7 | Triage: Buckets, reasons, summaries, Interrupts, Quiet, corrections, Mac notifications | M6, Interrupt rules | open AMC to a sorted inbox |
| M8 | Handoff and live composer: composer links, live Agent drafting, what-changed, select-and-revise, project picker, T3 integration | M4, M6, handoff design, T3 research | do the T3 reply flow without copy-paste |
| M9 | Hardening and cutover: backups and restore drill, credential encryption audit, performance budgets, health alerts, optional Gmail Pub/Sub, two weeks without Spark on the Mac | all | cancel Spark on the Mac |

M6 v1 uses expiring Agent tokens for external clients. The Host sandbox runner, per-run token minting, trusted forwarder, and Dangerously Allow Send are deferred.

Runs in parallel once M1 lands: M5 alongside M2–M4, and the agent tickets (headless proof, sandbox, permission model) alongside M2–M3.

## 11. Decisions (defaults taken 2026-11-20)

1. **Desktop shell:** Electron.
2. **Instant Gmail:** 15-second polling. Pub/Sub push stays optional; it needs billing on `amc-mail-x097y3`.
3. **Root disk:** untouched. AMC lives on `/srv` until Ralf frees the root disk.
4. **Offsite backups:** deferred. `/srv/backups/amc` only for now.
5. **First Gmail Account:** whichever Ralf signs in with first.
