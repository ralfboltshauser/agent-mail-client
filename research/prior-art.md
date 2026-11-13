# Prior art: open-source mail engines and agent mail clients

Research for [#4](https://github.com/ralfboltshauser/agent-mail-client/issues/4). Checked 2026-11-13 against repos, licence files, READMEs and first-party docs. Star counts and last-push dates come from the GitHub API on that day.

## Short answer

**No. There is no engine worth building AMC on as a whole.** Every candidate fails at least one hard constraint:

- **Licence.** AMC is MIT. The serious sync engines are GPL-3 (Mailspring-Sync, FairEmail, meli, notmuch), AGPL plus extra non-OSI restrictions (Inbox Zero), or commercial (EmailEngine).
- **Shape.** Some are the wrong kind of thing. Stalwart is a mail *server*, not a client that syncs from Gmail. Zero is tied to Cloudflare Workers and Durable Objects. aerc and Himalaya are terminal clients.
- **Health.** Zero has gone quiet: 5 commits in May 2026, 11 in October, none in between.

**Recommendation.** Write our own Engine, and assemble it from **permissively licensed protocol libraries**:

- Rust: `mail-parser`, `mail-builder` and `mail-send` (MIT/Apache), `async-imap` and `imap-codec` (Apache-2.0), and optionally the Pimalaya `io-*` crates (Apache-2.0, pre-1.0 and changing fast).
- TypeScript: ImapFlow (MIT).
- Gmail sync: the official Gmail API `history.list` plus Pub/Sub `watch`.

**Use these designs as inspiration only, never copying their code:**

- Mailspring-Sync's sync design.
- Inbox Zero's new portable `mail-core`/`mail-sqlite` engine.
- Delta Chat's "one Rust core behind JSON-RPC" pattern.
- JMAP's `/changes` + state-string model, as the shape of the Engine-to-Client protocol.
- Superhuman's speed rules: under 50 ms per action, a local database, prefetching, Cmd+K.

## Comparison

| Project | What it is | Licence | Activity (2026-11-13) | Reuse as dependency? | Learn from |
|---|---|---|---|---|---|
| [Mailspring-Sync](https://github.com/Foundry376/Mailspring-Sync) | C++ IMAP/SMTP sync engine (MailCore2 + SQLite), one process per account | GPL-3.0 | Very active (pushed 2026-11-12) | **No** (GPL; also needs a Mailspring ID) | Process per account, local/remote task split, JSON change stream on stdout, stable IDs, a window for fetching bodies |
| [Mailspring](https://github.com/Foundry376/Mailspring) | Electron desktop client on Mailspring-Sync | GPL-3.0 | Active, 18k stars | No | Reactive observable queries over the local DB |
| [Inbox Zero](https://github.com/elie222/inbox-zero) | AI assistant for Gmail/Outlook, now also a client (web, Electron, iOS) + MCP server + CLI | AGPL-3.0 **plus** commercial-use and 5+ user restrictions | Very active (daily) | **No** (non-OSI terms) | `mail-core` engine API, `mail-sqlite` store (contentless FTS5, compressed bodies), AI rules, Reply Zero, MCP tools |
| [Zero / 0.email](https://github.com/Mail-0/Zero) | AI-first Gmail alternative; Next.js + Cloudflare Workers/DOs | MIT | Mostly dormant in 2026 | Code is MIT, but tied to Cloudflare | Driver abstraction (Google / Microsoft / IMAP), agent + MCP Durable Objects, Gmail quota handling |
| [Stalwart](https://github.com/stalwartlabs/stalwart) | Rust mail *server* (JMAP, IMAP, SMTP, CalDAV…) | AGPL-3.0 / proprietary SELv2 | Very active, 15.9k stars | Not as our store (it's a server, not a Gmail/IMAP sync client) | JMAP server semantics, FTS, storage backends; it's also what Thundermail runs on |
| Stalwart libs ([mail-parser](https://github.com/stalwartlabs/mail-parser), mail-builder, mail-send, mail-auth) | Rust MIME parse/build, SMTP send, DKIM | MIT OR Apache-2.0 | Active | **Yes** | N/A |
| [Pimalaya / Himalaya](https://github.com/pimalaya/himalaya) | Rust CLI + `io-imap`, `io-gmail`, `io-jmap`, `io-oauth`… libraries | Apache-2.0 | Very active, breaking changes weekly | **Yes, with care** (pre-1.0, unstable API) | JSON-output CLI for agents; a Gmail REST backend alongside IMAP |
| [chatmail/core (Delta Chat)](https://github.com/chatmail/core) | Rust IMAP/SMTP core shared by Android, iOS and desktop over FFI/JSON-RPC | MPL-2.0 | Very active | Possible (file-level copyleft), but it's built for chat | One core, many thin clients; `deltachat-rpc-server` speaks JSON-RPC over stdio |
| [async-imap](https://github.com/chatmail/async-imap), [imap-codec](https://github.com/duesee/imap-codec), [rust-imap](https://github.com/jonhoo/rust-imap) | Rust IMAP clients/codecs | Apache-2.0 (and/or MIT) | Active | **Yes** | N/A |
| [ImapFlow](https://github.com/postalsys/imapflow) | Node IMAP client | MIT | Active | **Yes** (if the Engine is in TS) | N/A |
| [EmailEngine](https://github.com/postalsys/emailengine) | Self-hosted REST/webhook API in front of IMAP/Gmail/Graph | Commercial licence (v3.0 from 2026-12-10) | Active | **No** (paid, not open source) | Webhook-per-change API shape |
| [Thunderbird for Android (K-9)](https://github.com/thunderbird/thunderbird-android) | Native Android client | Apache-2.0 | Very active | Parts possible (Kotlin), but large | IMAP IDLE push; default-on push landed 2026-11-11 |
| [FairEmail](https://github.com/M66B/FairEmail) | Android client | GPL-3.0 | Very active | No | Battery-aware IDLE/sync scheduling, privacy defaults |
| [aerc](https://github.com/rjarry/aerc) | Go terminal client (IMAP, JMAP, Maildir, notmuch) | MIT | Active | Little (Go, TUI) | Vim-style binds, configurable keymaps, one worker per account |
| [notmuch](https://notmuchmail.org) + [lieer](https://github.com/gauteh/lieer) | Tag-based Xapian index over Maildir; lieer syncs Gmail labels as tags through the Gmail API | GPL-3.0 | Active | No | Tags as the core model (it maps cleanly to Gmail labels), fast search |
| [meli](https://github.com/meli/meli) | Rust terminal client | GPL-3.0 | Active | No | N/A |
| [Superhuman Mail](https://blog.superhuman.com/superhuman-is-built-for-speed/) | Commercial; owned by Grammarly, which renamed itself Superhuman in Oct 2025 | Proprietary | N/A | No | Under 50 ms target, local DB, prefetch/prerender, a shortcut for every action, Cmd+K |
| [Shortwave](https://www.shortwave.com/docs/how-tos/using-mcp/) | Commercial Gmail client with AI assistant | Proprietary | N/A | No | RAG over the mailbox; it's an MCP *client* (beta, tools only, 40-tool cap), the opposite of AMC's model |

## Details

### Mailspring-Sync: the best sync design to learn from, but GPL

From the [README](https://github.com/Foundry376/Mailspring-Sync):

- **One mailsync process per account.** The app restarts it as needed, so an auth or connection error "can simply terminate the process". This is a good fault-isolation model for our Engine (one supervised worker per Account).
- **Changes go out as newline-separated JSON objects on stdout.** Tasks come in on stdin. Each task has an immediate **local** part and a retryable **remote** part, and is queued in SQLite. This is the optimistic-UI pattern we want: the local DB changes first, and Clients see it at once.
- **Two IMAP connections per account.** A background worker uses CONDSTORE/QRESYNC sweeps or deep sync. A foreground worker IDLEs on the inbox and fetches bodies on demand.
- **Lessons the README itself states:**
  - The "fat JSON column + copied query columns" table design makes SCAN queries slow, and the authors "may have chosen a different approach".
  - Bodies are only fetched for the last 3 months.
  - Stable IDs come from header hashes, and they occasionally collide.
- **Can't use it as a dependency.** It is GPL-3.0 and needs a Mailspring ID (so it talks to id.getmailspring.com for metadata). It is still very active: the latest commits (Nov 2026) add Microsoft Graph contacts and a Dovecot/Cyrus test harness.

### Inbox Zero: the closest "agent mail" product, but the licence rules it out

- **[AGPL-3.0 plus additional terms](https://github.com/elie222/inbox-zero/blob/main/LICENSE).** You may not monetize it or a derivative without permission, and organisations with 5+ business users need an enterprise licence. Those extra terms make it **not OSI open source**. AMC cannot vendor it.
- **Now a client as well as an assistant.** It has web, an Electron shell ([apps/desktop](https://github.com/elie222/inbox-zero/tree/main/apps/desktop)), a closed-source native iOS app and an older React Native Android app.
- **Gmail and Outlook only. No IMAP.**
- **It has a [portable mail engine](https://github.com/elie222/inbox-zero/tree/main/packages/mail-core) worth reading.**
  - The engine is built from `MailStore`, `MailboxSource`, `OperationExecutor` and `HostRuntime`, and screens call `observeMailbox` / `observeConversation` / `observeOperation`. There are no React, DOM or Node imports.
  - Its [`mail-sqlite`](https://github.com/elie222/inbox-zero/tree/main/packages/mail-sqlite) store uses a contentless FTS5 index (SQLite 3.43+), raw-deflate body BLOBs, a driver contract test, and a 10k-conversation regression.
  - Good inspiration for AMC's local replica on desktop.
- **Ships an MCP server** (`apps/web/utils/mcp/*`, `plugins/inbox-zero-mcp`) **and a CLI.** Its AI-rules-in-plain-English and "Reply Zero" (to-reply / awaiting-reply tracking) are useful feature references for triage and Interrupts.
- **Its agent model doesn't fit ours.** It calls API-key LLM providers from the server. AMC instead runs Agents through the owner's Harness ([ADR 0002](https://github.com/ralfboltshauser/agent-mail-client/blob/main/docs/adr/0002-agents-run-through-the-owners-harness.md)).

### Zero (0.email): MIT, but stalled and tied to Cloudflare

- **[MIT-licensed](https://github.com/Mail-0/Zero).** Next.js front end.
- **The server is a Cloudflare Worker.** Its [`wrangler.jsonc`](https://github.com/Mail-0/Zero/blob/main/apps/server/wrangler.jsonc) declares Durable Objects `ZeroAgent`, `ZeroMCP`, `ZeroDB`, `ZeroDriver`, `WorkflowRunner` and `GmailQuota`, plus Queues, Vectorize and R2.
- **Mail drivers** for Google, Microsoft and IMAP (`apps/server/src/lib/driver/`).
- **Commit cadence in 2026:** 5 in May, 11 in October (the latest 2026-10-27, adding an assistant with Face ID approval for write tools). So it's not dead, but it's not a foundation to bet a daily driver on.
- **Small things worth borrowing:**
  - The driver interface.
  - The Gmail quota limiter.
  - The "approval for write tools" idea, which matches [ADR 0001](https://github.com/ralfboltshauser/agent-mail-client/blob/main/docs/adr/0001-agents-cannot-send-by-construction.md).

### Stalwart as the store? No

- **[Stalwart](https://github.com/stalwartlabs/stalwart) is an excellent Rust server.** It speaks JMAP (RFC 8620/8621), IMAP4rev2, SMTP and CalDAV/CardDAV, with FTS in 17 languages, pluggable RocksDB/Postgres/SQLite/S3 storage, and an AI spam classifier.
- **Licence:** AGPL-3.0 / proprietary SELv2. Thundermail runs on it ([Thunderbird roadmap](https://roadmaps.thunderbird.net/en-US/services/)).
- **But it receives mail; it doesn't sync it.** Nothing in it pulls from a Gmail or IMAP account and pushes changes back. Remote IMAP/SMTP appears only as a [delegated *authentication* backend](https://stalw.art/docs/auth/backend/remote), and its importers are for one-off migration.
- **Using it as AMC's store would still need our own two-way sync engine.** We would then be mirroring Gmail labels into Stalwart mailboxes and back: double the state, plus an AGPL server to run.
- **Its permissive parsing and sending libraries are the useful part.** `mail-parser`, `mail-builder`, `mail-send` and `mail-auth` are MIT OR Apache-2.0 (see each repo's `LICENSES/`).

### JMAP as the Engine-to-Client protocol shape

- **We don't need a JMAP *server* to borrow JMAP's [core model](https://jmap.io/spec-core.html) (RFC 8620):**
  - Typed objects (`Email`, `Thread`, `Mailbox`).
  - `Foo/get`, `Foo/query` and `Foo/changes` with opaque **state strings**.
  - Back-references so several calls go in one round trip.
  - Push via EventSource/WebSocket (RFC 8887).
- **This is exactly the shape a fast-sync replica needs.** A Client asks "what changed since state X", and the answer is cheap. It also gives Agents (MCP/CLI) and apps one consistent API.
- [`jmapio/jmap`](https://github.com/jmapio/jmap) (Apache-2.0) is the spec source. [`stalwartlabs/jmap-client`](https://github.com/stalwartlabs/jmap-client) (Apache-2.0) is a Rust client if we go fully JMAP.

### Gmail: use the Gmail API, not IMAP, as the primary path

- **Gmail API.** Google documents [partial sync via `history.list` from a `historyId`](https://developers.google.com/workspace/gmail/api/guides/sync) and [push via `users.watch` to a Cloud Pub/Sub topic](https://developers.google.com/workspace/gmail/api/guides/push). Labels map natively.
- **Others take this route too:**
  - lieer maps labels to notmuch tags via the API ([lieer](https://github.com/gauteh/lieer)).
  - Inbox Zero and Zero both use the Gmail API.
  - Himalaya now ships a Gmail REST backend (`io-gmail`).
- **IMAP (MailCore2 with Gmail extensions) is the fallback,** and it is what Mailspring uses.
- **Cost for a self-hoster:** a GCP project with Pub/Sub for push. Polling `history.list` is the zero-setup fallback.

### Speed and keyboard UX: what the leaders get right

- **Superhuman** ([blog](https://blog.superhuman.com/superhuman-is-built-for-speed/)):
  - It "treats the 100ms rule as the maximum, and actually aims for latency less than 50ms".
  - Keeps "a database of your emails stored in your app" so it can display offline.
  - "Preloads and prerenders the email threads that you're most likely to view soon".
  - Uses minimal animation.
  - Has a shortcut for every action, and Cmd+K Command for discovery, with hints in the UI.
  - Its [performance-metrics post](https://blog.superhuman.com/performance-metrics-for-blazingly-fast-web-apps-ec12efa26bcb) buckets latencies as under 50 ms, under 100 ms, under 1 s, and "terrible". That's a good model for our own telemetry.
- **Mailspring:** observable queries over a local SQLite replica, so no UI change waits on the network (local task first, remote later).
- **aerc / notmuch:**
  - Fully remappable keybindings ([aerc-binds(5)](https://git.sr.ht/~rjarry/aerc/tree/master/item/doc/aerc-binds.5.scd)).
  - Tags rather than folders.
  - Instant search from a local index.
- **Inbox Zero desktop:** one window per account, notifications that focus the right window, and a Dock badge for unread across accounts ([apps/desktop README](https://github.com/elie222/inbox-zero/tree/main/apps/desktop)).

### Agent-native products

- **Superhuman:** commercial.
  - Grammarly bought Superhuman in mid-2025 and renamed the whole company Superhuman in Oct 2025, launching the "Superhuman Go" assistant ([TechCrunch](https://techcrunch.com/2025/10/29/grammarly-rebrands-to-superhuman-launches-a-new-ai-assistant/)).
  - Its AI is in-app and vendor-hosted.
- **Shortwave:** commercial.
  - A RAG assistant ([engineering deep dive](https://www.shortwave.com/blog/deep-dive-into-worlds-smartest-email-ai/)).
  - Acts as an **MCP client**: beta, "limited to tool calls", up to 40 tools, local servers only on desktop ([docs](https://www.shortwave.com/docs/how-tos/using-mcp/)).
- **Inbox Zero:** open-core. Exposes an MCP *server* + CLI.
- **Zero:** an in-product agent plus an MCP Durable Object.
- **AMC's angle is open.** None of these treats the *owner's own coding-agent Harness* as a first-class Client of a self-hosted Engine, with send removed by construction. They either embed a vendor LLM or bolt tools onto a SaaS.

### Mobile references

- **[Thunderbird for Android](https://github.com/thunderbird/thunderbird-android)** (Apache-2.0, Kotlin; the old K-9). The most reusable Android mail code under a permissive licence. Default-on push was enabled for all builds on 2026-11-11.
- **[FairEmail](https://github.com/M66B/FairEmail)** (GPL-3.0). The reference for battery-aware IMAP IDLE and sync scheduling.
- **[Delta Chat core](https://github.com/chatmail/core)** (MPL-2.0). Shows one Rust core serving Android, iOS and desktop through FFI or `deltachat-rpc-server` (JSON-RPC 2.0 over stdio). This is the strongest precedent if AMC wants a shared Rust client library on desktop + Android.
- **Not usable as a dependency:** [EmailEngine](https://github.com/postalsys/emailengine) moved to licence agreement v3.0 (published 2026-11-10, in effect 2026-12-10), which licenses it for business use with an online licence check. It is not open source.

## Surprises

- **Inbox Zero has quietly become a full mail client** with a portable engine (`mail-core`, `mail-sqlite`) that is architecturally close to what AMC needs. Its licence (AGPL plus a no-monetization rider and a 5-user limit) means we can only read it.
- **Zero, the loudest "open-source AI Gmail" of 2025, is mostly dormant in 2026** and only runs on Cloudflare.
- **Mailspring-Sync is more active than ever** (Graph contacts, calendar, test harness in Nov 2026), but it is still GPL-3 and still needs a Mailspring ID.
- **Pimalaya moved on from its MIT `pimalaya/core` libs** (last pushed 2026-03) to many Apache-2.0 `io-*` crates (including `io-gmail` and `io-msgraph`). It's attractive, but it ships breaking changes almost daily, so if we use it we should pin versions.

## Sources

- Repos and licence files (GitHub API, 2026-11-13): Foundry376/Mailspring, Foundry376/Mailspring-Sync, elie222/inbox-zero, Mail-0/Zero, stalwartlabs/stalwart, stalwartlabs/mail-parser, stalwartlabs/mail-send, stalwartlabs/jmap-client, pimalaya/himalaya (and the pimalaya org), chatmail/core, chatmail/async-imap, duesee/imap-codec, jonhoo/rust-imap, postalsys/imapflow, postalsys/emailengine, thunderbird/thunderbird-android, M66B/FairEmail, rjarry/aerc, notmuch/notmuch, gauteh/lieer, meli/meli, jmapio/jmap. Each is linked in the table above.
- Mailspring-Sync README: https://github.com/Foundry376/Mailspring-Sync
- Inbox Zero LICENSE: https://github.com/elie222/inbox-zero/blob/main/LICENSE
- Inbox Zero mail-core / mail-sqlite: https://github.com/elie222/inbox-zero/tree/main/packages
- Zero wrangler config: https://github.com/Mail-0/Zero/blob/main/apps/server/wrangler.jsonc
- Stalwart README (features, licence): https://github.com/stalwartlabs/stalwart
- Stalwart remote auth backend: https://stalw.art/docs/auth/backend/remote
- Thunderbird services roadmap: https://roadmaps.thunderbird.net/en-US/services/
- JMAP core spec: https://jmap.io/spec-core.html
- Gmail API sync: https://developers.google.com/workspace/gmail/api/guides/sync
- Gmail API push: https://developers.google.com/workspace/gmail/api/guides/push
- Superhuman, built for speed: https://blog.superhuman.com/superhuman-is-built-for-speed/
- Superhuman, performance metrics: https://blog.superhuman.com/performance-metrics-for-blazingly-fast-web-apps-ec12efa26bcb
- Grammarly to Superhuman rebrand: https://techcrunch.com/2025/10/29/grammarly-rebrands-to-superhuman-launches-a-new-ai-assistant/
- Shortwave MCP docs: https://www.shortwave.com/docs/how-tos/using-mcp/
- Shortwave AI deep dive: https://www.shortwave.com/blog/deep-dive-into-worlds-smartest-email-ai/
- Delta Chat RPC server: https://github.com/chatmail/core/tree/main/deltachat-rpc-server
