# Local-first sync for instant UI over the Engine

Research for [#5](https://github.com/ralfboltshauser/agent-mail-client/issues/5): which local-first sync approaches can give the desktop instant UI over an Engine on the Host? Researched 2026-11-13. This is input for the architecture decision, not the decision itself.

## Short answer

The UI-speed trick is the same everywhere: the Client keeps a local replica, reads and writes hit it synchronously, and changes go upstream in the background. The real question is who owns the sync protocol. Three candidates fit AMC:

1. **Our own JMAP-style state sync (strongest fit).** The Engine keeps a monotonic change counter (`modseq`) per Account and data type. Clients keep a SQLite replica and pull `changes since <state>`. A push channel says "something changed". Writes are queued per Thread as patches. This is exactly how Fastmail built offline mail for users with millions of messages ([architecture](https://www.fastmail.com/blog/offline-architecture/), [sync back](https://www.fastmail.com/blog/offline-sync/), [mail storage](https://www.fastmail.com/blog/offline-mail-storage/)). It is close to Superhuman's per-Thread modifier queue ([Superhuman](https://blog.superhuman.com/architecting-a-web-app-to-just-work-offline-part-1/)) and to Linear's bootstrap plus delta packets. It is the only option that is equally native on a Swift or web macOS app, on Android, and for Agents. It also needs no Postgres or extra service on a Host that is already at 82% disk. The wire format can literally be JMAP ([RFC 8620](https://www.rfc-editor.org/rfc/rfc8620) / [RFC 8621](https://www.rfc-editor.org/rfc/rfc8621)), which already defines `/changes`, `/queryChanges`, patch updates of `keywords`/`mailboxIds`, and push. The cost is that we build and test the sync engine ourselves.
2. **PowerSync (best off-the-shelf).** This is the only maintained product with stable **Swift (macOS 12+), Kotlin (Android) and JS** SDKs. It offers offline writes through an upload queue, per-field last-write-wins by default, Apache-2.0 self-hosting, client SQLite with FTS5, and an attachments helper. Good performance is documented up to 1M rows per client ([limits](https://docs.powersync.com/resources/performance-and-limits.md), [platforms](https://docs.powersync.com/resources/supported-platforms.md)). The costs are that the Engine's store must be Postgres, MongoDB, MySQL or SQL Server, the Host runs another service, and the write path is still ours to build.
3. **Rocicorp Zero (fastest UI, wrong offline story).** Zero is GA (1.0 in March 2026, now 1.12) and Apache-2.0, and it was built for "like Linear" interaction speed ([status](https://zero.rocicorp.dev/docs/status), [when to use](https://zero.rocicorp.dev/docs/when-to-use)). It has three problems for AMC. It is **TypeScript-only**, so a native Android or Swift app is not possible (React Native is). It has **no offline writes**. Its partial sync caches query results for a TTL of at most 10 minutes instead of holding a durable mailbox replica. It is worth keeping only if v1 is a web-tech desktop app plus a React Native Android app, and offline triage is dropped.

The other options lose. Electric is read-path only with TS/Elixir clients. Triplit has been dormant since joining Supabase. cr-sqlite has had no release since January 2024. sqlite-sync's self-hosted path still registers with a hosted dashboard. LiveStore is event-sourced and TS-centred. Replicache is in maintenance mode. Litestream is a backup tool. Details are below.

## Comparison

| Approach | Status (Nov 2026) | Host requirements | macOS | Android | Agents | Offline reads / writes | Conflict model for flags/labels | Fit for 100k+ msgs |
|---|---|---|---|---|---|---|---|---|
| **Custom JMAP-style sync** | Pattern, proven by Fastmail in production since Dec 2024 | Only the Engine (any DB, e.g. SQLite) | Any (Swift or web) | Any (Kotlin or RN) | Same API | Yes / yes (queue) | Patches with per-property LWW. `keywords/$seen` and `mailboxIds/<id>` patches merge naturally | Yes. Sync all metadata, page bodies in |
| **PowerSync** | Active. Service v1.28.3 (2026-11-12), Swift 1.17, Kotlin 1.16 | Postgres/Mongo/MySQL/MSSQL source + PowerSync service + bucket storage (can be Postgres) | Swift SDK stable | Kotlin SDK stable | Through the Engine's API | Yes / yes (upload queue) | Per-field LWW by default, custom in your backend | Documented good to 1M rows/client |
| **Zero** | GA. 1.0 Mar 2026, 1.12.0 (2026-11-12) | Postgres + zero-cache (SQLite replica, wants NVMe) + query/mutate endpoints | Web tech only | React Native only | Through the Engine's API | Cached reads only / **no** | Server-authoritative mutators (re-run on server) | Partial sync. Not a full replica |
| **Electric (+TanStack DB)** | Active. sync-service 1.8.1 (Sep 2026). TanStack DB 1.0 RC. Company focus moving to agents/Durable Streams | Postgres + Electric | TS client (or write your own HTTP client) | TS/RN (or write your own) | Through the Engine's API | Yes / DIY | DIY (read-path only) | Shapes. Fine |
| **LiveStore** | Active. v0.5.0 (Oct 2026), pre-1.0 | Sync backend (Cloudflare or your own) | Web / Electron | Expo | Via events | Yes / yes | Event-sourced. You write the materialisers | Event log grows with history |
| **cr-sqlite** | Stale. Last release v0.16.3, Jan 2024. Build fixes only in 2026 | Your own relay | Extension | Extension | – | Yes / yes | CRDT (LWW per column) | Untested at this scale |
| **sqlite-sync (SQLite AI)** | Active. 1.2.2 (Nov 2026) | Postgres extension **plus registration in the hosted CloudSync dashboard** | Swift package | Maven | – | Yes / yes | CRDT (CLS, delete-wins, add-wins) | Unknown |
| **Triplit** | Dormant. Last commit Sep 2025. Founder joined Supabase Oct 2025. AGPL | Triplit server | Web/RN | RN | – | Yes / yes | Attribute LWW | – |
| **Replicache** | Maintenance mode, superseded by Zero | Your own push/pull endpoints | Web | – | – | Yes / yes | Server-authoritative | Holds the full client view |
| **Litestream** | Active (v0.5.18), but a disaster-recovery tool | – | – | – | – | Read-only VFS replicas from S3 | None (single writer) | Not a client sync. Useful for **Host backups** |

## What the reference apps do

### Superhuman

- Their offline write-up says the client caches "everything it needs to display an email, including attachments, images, and message content". It used WebSQL for metadata and content, and CacheStorage for code and attachments ([Superhuman, part 1](https://blog.superhuman.com/architecting-a-web-app-to-just-work-offline-part-1/)).
- Every user action is a **modifier**. Its `modify` step changes local data synchronously and its `persist` step sends the change to the server asynchronously. There is **one modifier queue per email Thread** so changes stay in order. Modifiers are persisted to disk, retried, and dropped on permanent failure, and then the view is rebuilt from the cache plus the remaining modifiers.
- They found `navigator.onLine` unreliable and built their own connectivity detection.
- Search is local over the device cache ([Delightful search](https://blog.superhuman.com/delightful-search-more-than-meets-the-eye/)).

### Linear

- Linear's own page only announces the talk ([Scaling the Linear Sync Engine](https://linear.app/now/scaling-the-linear-sync-engine)). The detail comes from a reverse-engineering study ([wzhudev/reverse-linear-sync-engine](https://github.com/wzhudev/reverse-linear-sync-engine), **secondary**). By that account:
  - The client keeps an in-memory object graph backed by IndexedDB.
  - On startup it does a full bootstrap, then applies **delta packets** keyed by a server-wide, monotonically increasing `lastSyncId`.
  - Local changes update memory immediately and are sent as transactions. IndexedDB is only updated when the server echoes the delta.
  - Conflicts are last-write-wins, with CRDTs used only for rich-text descriptions.
- Zero's authors describe their product as a general-purpose version of the engines Superhuman (2017) and Linear (2019) built by hand ([zero: What is Sync?](https://zero.rocicorp.dev/docs/sync)).

### Fastmail (the closest analogue: a mail client on JMAP)

Fastmail is the closest match to AMC's problem.

- **Architecture.** The layering is `[App] ←JMAP→ [caching layer in a SharedWorker] ←JMAP→ [server]`. The local cache answers JMAP requests itself where it can, and sends the rest to the server ([architecture](https://www.fastmail.com/blog/offline-architecture/)).
- **Local store.** IndexedDB has one store per type. Each store keeps metadata `hasAllRecords`, `serverState`, `lastModSeq` and `highestPurgedModSeq`. Each record keeps created/updated modseqs and a `destroyed` flag. An index on the updated modseq makes "what changed since X" cheap. Tombstones are kept until a threshold is crossed.
- **Writes and conflicts.** An ordered log records `[type, account, id]`, and each record keeps a reverse patch to the server state. A re-edit that reverts a change drops it from the log. Conflicts are **last write wins, and all updates are patches**, so concurrent changes merge "unless they apply to the same property on the object" ([sync](https://www.fastmail.com/blog/offline-sync/)).
- **What is cached** ([mail storage](https://www.fastmail.com/blog/offline-mail-storage/)):
  - Metadata and basic headers for **all** messages, paged in batches.
  - Bodies for pinned and recent messages only, or all of them if the user opts in.
  - The attachment **list only, not attachment data**.
  - An on-device search index over downloaded messages. Attachment text is not indexed, and search tries the server first.
  - They note users with "millions of messages", and bodies of "hundreds of kilobytes of HTML".

## Candidate details

### 1. Custom JMAP-style state sync

**How it maps to AMC**

- The Engine already has to normalise Gmail (history IDs) and IMAP (CONDSTORE/QRESYNC modseqs, [RFC 7162](https://www.rfc-editor.org/rfc/rfc7162)) into one model. Giving that model a per-Account change counter is a small step.
- Clients call `Email/changes sinceState=X` and get created/updated/destroyed ids ([RFC 8620 §5.2](https://www.rfc-editor.org/rfc/rfc8620#section-5.2)). List views use `/queryChanges` (§5.6).
- Writes use `/set` with an optional `ifInState` for optimistic concurrency (§5.3).
- Flags and labels are **patches**: `"keywords/$seen": true`, `"mailboxIds/<id>": null` ([RFC 8621 §4.6](https://www.rfc-editor.org/rfc/rfc8621#section-4.6)). Archive, read, star and label are therefore commutative per property, which avoids most conflicts without CRDTs.
- Push only signals that a type's state changed, and clients then pull. Dropped pushes are harmless by design ([RFC 8620 §7](https://www.rfc-editor.org/rfc/rfc8620#section-7)). §7.3 defines an EventSource (SSE) transport. That suits Tailscale-connected desktops, and Android can use the same transport or a separate push path (see the push research).
- Agents can use the same API (or a CLI/MCP wrapper over it). That keeps "Clients are equal" literally true.

**Initial sync size (rough estimate, not measured)**

- 100k messages × ~0.5–1 KB of list metadata (ids, Thread, from/to, subject, date, snippet, keywords, labels) is roughly **50–100 MB** of SQLite. That is fine for a full metadata sync on both Mac and Android.
- Bodies are the expensive part. At tens to hundreds of KB each, all bodies come to several GB. Follow Fastmail: bodies for recent and pinned messages plus on demand, with "all bodies" as an opt-in on the Mac. Fetch attachments lazily and cache them in a size-capped content-addressed store.

**Risks**

- This is a sync engine we own.
- Edge cases need tests:
  - `cannotCalculateChanges`, which forces a resync.
  - Tombstone purging.
  - Mapping ids created offline.
  - Ordering within a Thread queue.
  - Schema migrations on Clients.
- Fastmail's and Superhuman's write-ups are a good checklist for these.

### 2. PowerSync

- **Model.** The PowerSync Service replicates the source DB, partitions it into buckets with **Sync Streams**, and streams it into a client-side SQLite ([overview](https://docs.powersync.com/intro/powersync-overview), [client architecture](https://docs.powersync.com/architecture/client-architecture.md)).
- **Writes.** Local writes go to SQLite immediately and into an ordered upload queue. Your backend drains that queue and applies it ("server-authoritative reconciliation"). The simplest backend gives **per-field LWW** ([conflicts](https://docs.powersync.com/handling-writes/handling-update-conflicts.md)).
- **Self-hosting.** The service is a Docker image, and the repo is Apache-2.0. Bucket storage can be MongoDB or **Postgres**. The hosted dashboard is not available when self-hosting ([self-hosting](https://docs.powersync.com/intro/self-hosting.md), [config](https://docs.powersync.com/configuration/powersync-service/self-hosted-instances.md), [repo](https://github.com/powersync-ja/powersync-service)).
- **Limits** ([limits](https://docs.powersync.com/resources/performance-and-limits.md)):
  - Good performance up to 1M rows per client, and "may still work" up to 10M.
  - 2k–20k ops/s client sync speed.
  - 15 MB max row size.
  - 1,000 buckets per user by default ([bucket limits](https://docs.powersync.com/sync/streams/bucket-count.md)), which is trivial for one owner.
- **Platforms.** Swift on macOS 12+/iOS. Kotlin on Android SDK 23+, iOS, macOS native and JVM. JS, React Native, Flutter, .NET (beta), Rust (beta) ([platforms](https://docs.powersync.com/resources/supported-platforms.md)).
- **Extras.** An attachments queue, built in on Swift/Kotlin as **alpha** ([attachments](https://docs.powersync.com/client-sdks/advanced/attachments.md)). Client-side FTS5 search ([FTS](https://docs.powersync.com/client-sdks/full-text-search.md)).
- **Caveat.** By default, synced tables are SQLite *views over JSON*. "Managed tables" or raw tables are needed for real indexes and speed at 100k+ rows ([client architecture](https://docs.powersync.com/architecture/client-architecture.md), [raw tables](https://docs.powersync.com/client-sdks/advanced/raw-tables.md)).
- **What it means for AMC.** The Engine's store becomes Postgres. The Host runs Postgres + PowerSync + the Engine. The write endpoint and conflict rules are still ours. What we gain is a maintained replication layer, client SDKs and an upload queue on all three platforms.

### 3. Rocicorp Zero

- **Model** ([llms.txt](https://zero.rocicorp.dev/llms.txt), [queries](https://zero.rocicorp.dev/docs/queries)):
  - zero-cache replicates Postgres into a SQLite replica.
  - Clients run named queries and mutators optimistically against a local store (IndexedDB, or SQLite on React Native).
  - The server re-runs mutators against Postgres, so writes are authoritative.
- **GA and license.** GA since March 2026, Apache-2.0 ([status](https://zero.rocicorp.dev/docs/status), [open source](https://zero.rocicorp.dev/docs/open-source)).
- **Blockers for AMC** ([when to use](https://zero.rocicorp.dev/docs/when-to-use), [connection/offline](https://zero.rocicorp.dev/docs/connection)):
  - "Zero is written in TypeScript and only supports TypeScript clients". React Native/Expo is supported ([RN](https://zero.rocicorp.dev/docs/react-native)), but native Swift and Kotlin are not.
  - "Zero doesn't support offline writes". When disconnected, reads work and writes are rejected.
  - "Zero is not local-first". Query TTLs are at most 10 minutes. Data stays only while a query is active or within its TTL, so the client holds a working set, not the mailbox.
  - First-class text search is still on the roadmap.
- **Why it's still interesting.** Its interaction-speed design is exactly what a keyboard-first client wants, and it is the most mature commercial option for that.

### Others (why they lose)

- **Electric.**
  - Electric "does read-path sync… does not do write-path sync" ([writes guide](https://electric.ax/docs/sync/guides/writes.md)).
  - It has official TS and Elixir clients only. Other languages must implement the HTTP shape protocol ([client development](https://electric.ax/docs/sync/guides/client-development.md)).
  - The project now pitches itself around multi-agent systems and Durable Streams ([llms.txt](https://electric.ax/llms.txt)).
  - The sync service is at 1.8.1 (Sep 2026, [releases](https://github.com/electric-sql/electric/releases)).
  - TanStack DB, its recommended client store, is still a 1.0 RC (npm `@tanstack/db` 1.0.0-rc.1.5).
- **LiveStore.**
  - Event-sourced and reactive, with SQLite on the client and adapters for web, Expo and desktop ([repo](https://github.com/livestorejs/livestore)).
  - It is pre-1.0 (v0.5.0).
  - Event sourcing fits an Engine that ingests from IMAP/Gmail badly, because the provider is the real source of change, not the client's event log.
- **cr-sqlite.** It is a CRDT extension for SQLite ([repo](https://github.com/vlcn-io/cr-sqlite)), but the last release was v0.16.3 in January 2024. That is too stale to build v1 on.
- **sqlite-sync (SQLite AI).**
  - CRDT extension with Swift/Android/WASM packages, Apache-2.0 ([repo](https://github.com/sqliteai/sqlite-sync)).
  - The self-hosted Postgres quickstart still has you register the database in the hosted CloudSync dashboard ([quickstart](https://github.com/sqliteai/sqlite-sync/blob/main/docs/postgresql/quickstarts/postgres.md)). That conflicts with "every user self-hosts".
- **Triplit.**
  - Its co-founder joined Supabase in October 2025 ([Supabase blog](https://supabase.com/blog/triplit-joins-supabase)).
  - The repo is AGPL-3.0 with its last commit in September 2025 ([repo](https://github.com/aspen-cloud/triplit)).
- **Replicache.** In maintenance mode and open-sourced, with Zero as the successor ([replicache.dev](https://replicache.dev/), [Retiring Reflect](https://rocicorp.dev/blog/retiring-reflect)).
- **Litestream.** "A standalone disaster recovery tool for SQLite" ([repo](https://github.com/benbjohnson/litestream)). Its v0.5 VFS read replicas are read-only copies from object storage ([VFS guide](https://litestream.io/guides/vfs/)), which is not a client sync. It is a good candidate for **backing up the Engine's SQLite** under Host operations.

## Cross-cutting answers to the ticket's sub-questions

- **Initial sync size.**
  - Sync all metadata. 100k messages is about 50–100 MB (estimate), well inside PowerSync's 1M-rows guidance and trivial for a custom SQLite replica.
  - Treat bodies and attachments as a separate, lazily filled cache with a size cap, as Fastmail does.
  - Zero is the odd one out because it syncs working sets, not the mailbox.
- **Offline.** Superhuman and Fastmail both treat offline triage as a core feature. Every candidate supports it except Zero, which has no offline writes.
- **Conflict model for flags/labels.** Every serious mail implementation lands on server-authoritative state with **per-property patches and last-write-wins**: JMAP keyword/mailbox patches, Fastmail, PowerSync's default, Linear. CRDTs buy nothing here. The hard part is ordering: a per-Thread queue (Superhuman) plus the Engine as the single writer to IMAP/Gmail.
- **Attachments.** Nobody syncs them eagerly. Fastmail stores only the list. PowerSync ships an attachment queue (alpha on native). In a custom design, a content-addressed blob cache fetched on demand is enough.
- **Android.**
  - Custom sync and PowerSync work natively.
  - Zero, Electric and LiveStore need React Native/Expo (or a hand-written Electric client).
  - sqlite-sync works on Android, but its self-hosting comes with a hosted dashboard.

## Sources

Primary unless noted.

- Superhuman: <https://blog.superhuman.com/architecting-a-web-app-to-just-work-offline-part-1/>, <https://blog.superhuman.com/delightful-search-more-than-meets-the-eye/>
- Linear: <https://linear.app/now/scaling-the-linear-sync-engine>. Secondary: <https://github.com/wzhudev/reverse-linear-sync-engine>
- Fastmail: <https://www.fastmail.com/blog/offline-architecture/>, <https://www.fastmail.com/blog/offline-sync/>, <https://www.fastmail.com/blog/offline-mail-storage/>
- JMAP: <https://www.rfc-editor.org/rfc/rfc8620>, <https://www.rfc-editor.org/rfc/rfc8621>. IMAP CONDSTORE/QRESYNC: <https://www.rfc-editor.org/rfc/rfc7162>
- Zero: <https://zero.rocicorp.dev/llms.txt>, <https://zero.rocicorp.dev/docs/status>, <https://zero.rocicorp.dev/docs/when-to-use>, <https://zero.rocicorp.dev/docs/connection>, <https://zero.rocicorp.dev/docs/queries>, <https://zero.rocicorp.dev/docs/react-native>, <https://zero.rocicorp.dev/docs/open-source>, <https://zero.rocicorp.dev/docs/sync>. npm `@rocicorp/zero` 1.12.0 (2026-11-12)
- Replicache: <https://replicache.dev/>, <https://rocicorp.dev/blog/retiring-reflect>
- PowerSync: <https://docs.powersync.com/intro/powersync-overview>, <https://docs.powersync.com/architecture/client-architecture.md>, <https://docs.powersync.com/handling-writes/handling-update-conflicts.md>, <https://docs.powersync.com/resources/performance-and-limits.md>, <https://docs.powersync.com/sync/streams/bucket-count.md>, <https://docs.powersync.com/resources/supported-platforms.md>, <https://docs.powersync.com/intro/self-hosting.md>, <https://docs.powersync.com/configuration/powersync-service/self-hosted-instances.md>, <https://docs.powersync.com/client-sdks/advanced/attachments.md>, <https://docs.powersync.com/client-sdks/full-text-search.md>, <https://docs.powersync.com/client-sdks/advanced/raw-tables.md>, <https://github.com/powersync-ja/powersync-service> (Apache-2.0, v1.28.3)
- Electric: <https://electric.ax/llms.txt>, <https://electric.ax/docs/sync/guides/writes.md>, <https://electric.ax/docs/sync/guides/client-development.md>, <https://github.com/electric-sql/electric/releases>
- LiveStore: <https://github.com/livestorejs/livestore> (v0.5.0, 2026-10-15)
- cr-sqlite: <https://github.com/vlcn-io/cr-sqlite> (v0.16.3, 2024-01-17)
- sqlite-sync: <https://github.com/sqliteai/sqlite-sync>, <https://github.com/sqliteai/sqlite-sync/blob/main/docs/postgresql/quickstarts/postgres.md>
- Triplit: <https://supabase.com/blog/triplit-joins-supabase>, <https://github.com/aspen-cloud/triplit>
- Litestream: <https://github.com/benbjohnson/litestream>, <https://litestream.io/guides/vfs/>
