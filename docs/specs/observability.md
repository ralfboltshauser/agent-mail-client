# Local observability

Inventory against main at `7a7ae2a`. The owner should be able to take the Details from a failure, find the matching log lines in minutes, and tell which component failed and what it was doing. [ADR 0006](../adr/0006-local-structured-observability.md)

## Diagnostic paths at the baseline

| Path | Existing behavior |
| --- | --- |
| Engine stdout and journald | `apps/engine/src/log.ts` configures Pino with `service`, ISO time and the Engine config level. The systemd service collects stdout and stderr. The deploy script tails the unit on failure. The backup unit has its own journal. Pino call sites and direct console writes are indexed below. Legacy calls can contain provider errors or request data. |
| Engine health | Public `GET /health` reports liveness and version. Authenticated `GET /v1/health` reports operational health, including Account addresses and stored error text, disk paths, backup and queue status. `packages/protocol/src/doctor.ts` computes `doctorWarnings` for CLI doctor and the Desktop sync loop. Treat health responses and displayed warnings as application data. |
| Engine provider and request state | `account.last_error` and the mutation, Outbox and triage tables carry operation state. HTTP response error codes and messages reach Clients. IMAP wire logging is disabled in `providers/imap/client.ts`. Gmail failure responses, Pub/Sub retry paths and SSE/WebSocket lifecycles have separate error paths. |
| Desktop startup and console | `apps/desktop/src/main/index.ts` appended timestamped startup and feedback messages to `startup.log` under Electron userData. The feedback skill grepped for `Engine sync phase: live`. Electron main also writes to console. The repository has no producer or tracked reader for `startup-verification.log`. Treat any existing copy as a legacy local artifact. |
| Desktop triage and renderer | Main reads and writes `triage-run.json` under userData for the last-run status displayed in the UI. The child launched by `triage-process.ts` ignores stdio. Renderer failure text appears in status, toasts, and dialogs, with no central runtime error forwarder. Feedback stores a screenshot and hands its path and the owner's submitted text to local T3. Handoff and draft recovery retain their own application state. |
| CLI output | `apps/cli/src/main.ts`, `signin.ts`, `imap-signin.ts`, and `smart-inbox.ts` write command results, interactive prompts and errors. Some commands intentionally print mail or credentials as their result. The process-level catch displays an error message or the error object with `AMC_DEBUG=1`. Triage harness stdout/stderr are captured separately in `triage-claude.ts`. CLI output and child streams are unsuitable as log input. |
| MCP errors | `apps/engine/src/mcp/server.ts` returns SDK tool errors and explicit `isError` results. `http/app.ts` mounts the authenticated streamable HTTP transport on `/mcp`. Desktop `main/t3.ts` is a separate MCP client for T3 launch. These errors currently have no catalog or common correlation with tool calls. |
| Shell and build diagnostics | `scripts/deploy-host.sh`, `scripts/provision-host.sh`, `scripts/install-{cli,desktop}.sh`, `scripts/setup-gmail-pubsub.sh`, `scripts/create-signing-identity.sh`, `deploy/amc-*.sh`, and Desktop packaging hooks report through the terminal, subprocess exits, or the service journal. Preserve intended CLI/build output and report only classified failures from those streams. |

## Event and privacy contract

- Each write is one UTF-8 JSON line with `ts` (UTC ISO-8601), `level`, `component`, and a stable dotted `event`. Optional envelope fields are `msg`, `requestId`, `runId`, `accountId`, `spanId`, and `parentSpanId`. Event fields include `durationMs` and `err` where declared. `msg` comes from the event catalog.
- Use the typed catalog in [packages/observability/src/events.ts](../../packages/observability/src/events.ts). Add fields in the slice's catalog. The runtime projects declared keys and validates primitive values. Fields can be internal IDs, finite durations, counts, booleans, closed enums and registered route templates. Use AMC Account IDs from the Account record. Use actual router patterns and the `unmatched` sentinel. Never pass a request path, URL, query, body, headers, CLI argv, provider response, or rendered UI text as a field.
- Mail subjects, bodies, sender and recipient addresses, display names, attachment names, owner reasons, credentials and OAuth data are prohibited at every supported level. Use status codes, counts, curated failure classes and static stage names to diagnose failures.
- `err` contains a recognized `class`, optional recognized `code`, a sanitized `message`, and up to eight own `stack` frames expressed as static source labels with line and column. Register exact owned V8 paths or file URLs in trusted process configuration. Keep that map build-aware for bundled and source-mapped stacks. Raw function names, absolute paths, causes and foreign frames stay outside the output. The sanitizer redacts addresses, long quoted strings, credential patterns and caps inspection at 256 characters. Only recognized resulting phrases survive. Bare words and unquoted mail text cannot be distinguished reliably, so unknown phrases become `[redacted]`. Add narrow static error codes and stages when a failure needs more detail.
- Default to `info`. Honor `AMC_LOG_LEVEL=debug|info|warn|error`. The Engine falls back to its existing configuration. Desktop Phase 2 adds an owner preference for debug, with the environment override taking precedence. Use `debug` for routine repeated activity, counts and summaries for per-message work, and coalesce or sample repeating errors with a count and window. Preserve the first failure and recovery.
- The renderer IPC contract ships metadata only. Main verifies the application's own main frame, validates and rate-limits input, and logs using the `renderer` component. Collect window errors, unhandled rejections, the React error boundary, and failed IPC calls. Use `amc:observability` and the `RendererLogReport` type. Forward only the fixed source and error class with optional correlation IDs. Classify renderer-only errors before forwarding and associate the main-side error with the same request ID for IPC failures.

## Correlation

Every Desktop, CLI and MCP Engine HTTP request gets a fresh UUID v4 in `x-amc-request-id` from `fetchWithRequestId`. Reserve that ID before submitting when the Client must show it if the network fails. Engine middleware accepts canonical UUID v4 values, generates one for missing or malformed input, exposes it as `c.get('requestId')`, echoes it in the response header, and emits `http.request`. Requests rejected by authentication still receive an ID. Successful health and replica-state polling are debug events. HTTP streaming duration covers producing the response, with stream termination handled by a separate event. WebSocket upgrades and transport-managed operations need their own boundaries.

Assign a `runId` to a triage run, sync cycle, IMAP action, deploy migration, feedback launch or handoff. Allocate it at admission and carry it through retries and subprocess boundaries via trusted metadata. Child work uses `log.with({ runId, requestId, accountId }).span(operation, fn)`. A span records start and finish, duration, outcome and sanitized error on failure, with an independent `spanId` and optional `parentSpanId`. Retain specific events such as `triage.run.failed` and `sync.imap.idle.reconnect` for domain outcomes. Every owner-visible failure has Details containing a short error class and the corresponding request ID or run ID. The same ID appears on a local log record even when the Engine was unreachable.

## Storage and retention

- Keep JSON logs on the machine that produced them. Engine request logs go to stdout and systemd journald. Phase 2 migrates legacy Engine Pino calls and service errors there. Journald already supervises the unit, supports local filtering, and owns rotation and file permissions. Phase 2 gives the dedicated AMC host a persistent local journal, `MaxRetentionSec=14day`, `MaxFileSec=1day`, and a `SystemMaxUse=250M` cap. The cap may shorten history, and expiration operates on journal files. Confirm forwarding is disabled and access remains restricted to local authorized users. [systemd journal configuration](https://www.freedesktop.org/software/systemd/man/latest/journald.conf.html)
- On macOS use `~/Library/Logs/AMC/{main,renderer,cli,mcp}.log`. Each component has one writer and at most five files including the active file, 10 MiB per file, and 14-day file retention. Apply private file and directory permissions and prune on open and while the writer is alive. When the application is closed, the next writer prunes at start. Rotation is best-effort. A failed sink write must leave the application operation usable. Desktop main owns `main.log` and eventually `renderer.log`. Phase 2 must serialize rotation and append across overlapping CLI and local MCP processes before enabling shared files. On the Linux Host, an installed CLI uses a private per-user log directory and can read Engine journald locally if authorized.
- Desktop main now writes `desktop.sync.phase` with `phase: "live"` and the message `Engine sync phase: live` in `main.log`. The runbook gives the replacement search. Legacy startup files are retired and excluded from diagnostics. The owner may remove their copies after upgrading. `triage-run.json` remains the UI's last-run state. Exports exclude it.

## Owner diagnostics surfaces

- Phase 2 adds owner-only `GET /v1/diagnostics`. Apply the Engine's owner-admin authorization before collection and return `Cache-Control: no-store`. Reject Agent tokens and Account-bound grants. Return a dedicated, runtime-validated payload with version, schema version, uptime, queue depths and counters, and last-success / last-failure timestamps plus the error class per sync Account, Pub/Sub, IMAP IDLE, purge job and migration. Use opaque Account IDs. Use null for unobserved states and expose no raw errors or existing health payloads.
- `amc diagnostics` reads the owner diagnostics snapshot and prints sanitized JSON. `amc logs [--component] [--since] [--run <id>] [--request <id>]` filters structured local logs and rotated siblings. A Host invocation may query local journald using current user permissions. A Mac invocation reads Mac logs. Preserve existing command output and MCP transport semantics. The diagnostics endpoint serves a status snapshot with no journal or log-file access.
- Desktop **Copy diagnostics** builds a bounded sanitized bundle in main with installed versions, recent local warn/error records and the dedicated diagnostics snapshot. Record Engine availability with a fixed status when its snapshot is unavailable. The same bounded reader supplies a private recent-log excerpt for the existing **⌘⇧F** handoff. Add only its local path to the handoff message and clean it up on the feedback artifact lifecycle. Validate parsed local records and project the current schema again before any copy or excerpt. Unknown schemas, malformed lines, legacy files, raw subprocess output and user feedback text are outside the log excerpt. Existing MCP authorization and Agent send restrictions apply throughout. [ADR 0001](../adr/0001-agents-cannot-send-by-construction.md)

## Call-site inventory

The following lists use repository-relative `file:line` locations from the baseline. Application and tooling lists exclude test sources and generated or vendored documents. Catch lists include expected fallbacks, parsing and intentional best-effort cleanup so each slice can distinguish recoverable outcomes from failures that need an event. Preserve existing API responses and retries when adding instrumentation.

### Console calls

- `apps/cli/src/main.ts:53`, `apps/cli/src/main.ts:54`, `apps/cli/src/main.ts:65`, `apps/cli/src/main.ts:68`, `apps/cli/src/main.ts:71`, `apps/cli/src/main.ts:72`, `apps/cli/src/main.ts:75`, `apps/cli/src/main.ts:89`, `apps/cli/src/main.ts:93`, `apps/cli/src/main.ts:100`, `apps/cli/src/main.ts:103`, `apps/cli/src/main.ts:111`, `apps/cli/src/main.ts:117`, `apps/cli/src/main.ts:120`, `apps/cli/src/main.ts:123`, `apps/cli/src/main.ts:137`, `apps/cli/src/main.ts:138`, `apps/cli/src/main.ts:150`, `apps/cli/src/main.ts:156`, `apps/cli/src/main.ts:170`, `apps/cli/src/main.ts:185`, `apps/cli/src/main.ts:192`, `apps/cli/src/main.ts:195`, `apps/cli/src/main.ts:233`, `apps/cli/src/main.ts:245`, `apps/cli/src/main.ts:246`, `apps/cli/src/main.ts:247`, `apps/cli/src/main.ts:249`, `apps/cli/src/main.ts:250`, `apps/cli/src/main.ts:265`, `apps/cli/src/main.ts:287`, `apps/cli/src/main.ts:291`, `apps/cli/src/main.ts:294`, `apps/cli/src/main.ts:357`, `apps/cli/src/main.ts:392`, `apps/cli/src/main.ts:393`, `apps/cli/src/main.ts:446`, `apps/cli/src/main.ts:449`, `apps/cli/src/main.ts:450`, `apps/cli/src/main.ts:453`, `apps/cli/src/main.ts:454`, `apps/cli/src/main.ts:457`, `apps/cli/src/main.ts:489`, `apps/cli/src/main.ts:501`, `apps/cli/src/main.ts:540`, `apps/cli/src/main.ts:542`, `apps/cli/src/main.ts:548`, `apps/cli/src/main.ts:556`, `apps/cli/src/main.ts:559`, `apps/cli/src/main.ts:564`, `apps/cli/src/main.ts:591`, `apps/cli/src/main.ts:644`, `apps/cli/src/main.ts:645`
- `apps/cli/src/signin.ts:48`, `apps/cli/src/signin.ts:49`
- `apps/cli/src/smart-inbox.ts:32`, `apps/cli/src/smart-inbox.ts:83`, `apps/cli/src/smart-inbox.ts:103`, `apps/cli/src/smart-inbox.ts:122`, `apps/cli/src/smart-inbox.ts:135`, `apps/cli/src/smart-inbox.ts:137`, `apps/cli/src/smart-inbox.ts:138`, `apps/cli/src/smart-inbox.ts:139`, `apps/cli/src/smart-inbox.ts:154`, `apps/cli/src/smart-inbox.ts:211`, `apps/cli/src/smart-inbox.ts:216`, `apps/cli/src/smart-inbox.ts:217`, `apps/cli/src/smart-inbox.ts:219`, `apps/cli/src/smart-inbox.ts:283`
- `apps/desktop/build/packaging-hooks.mjs:30`
- `apps/desktop/src/main/index.ts:273`, `apps/desktop/src/main/index.ts:1002`, `apps/desktop/src/main/index.ts:1018`, `apps/desktop/src/main/index.ts:1044`, `apps/desktop/src/main/index.ts:1061`
- `apps/desktop/src/main/renderer-load.ts:18`, `apps/desktop/src/main/renderer-load.ts:33`
- `apps/desktop/src/main/replica.ts:146`
- `apps/desktop/src/main/tray.ts:25`, `apps/desktop/src/main/tray.ts:46`
- `apps/engine/src/main.ts:65`, `apps/engine/src/main.ts:69`, `apps/engine/src/main.ts:84`, `apps/engine/src/main.ts:85`, `apps/engine/src/main.ts:93`, `apps/engine/src/main.ts:108`, `apps/engine/src/main.ts:115`, `apps/engine/src/main.ts:116`, `apps/engine/src/main.ts:301`, `apps/engine/src/main.ts:307`
- `scripts/lint-renderer.mjs:34`, `scripts/lint-renderer.mjs:39`

### Pino calls

- `apps/engine/src/db/database.ts:91`, `apps/engine/src/db/database.ts:106`
- `apps/engine/src/http/app.ts:80`, `apps/engine/src/http/app.ts:89`, `apps/engine/src/http/app.ts:104`, `apps/engine/src/http/app.ts:110`
- `apps/engine/src/http/mail.ts:98`, `apps/engine/src/http/mail.ts:172`, `apps/engine/src/http/mail.ts:180`
- `apps/engine/src/mail/avatars/index.ts:117`, `apps/engine/src/mail/avatars/index.ts:187`
- `apps/engine/src/mail/avatars/store.ts:45`
- `apps/engine/src/mail/mutations.ts:341`
- `apps/engine/src/mail/triage/purge-maintenance.ts:10`
- `apps/engine/src/main.ts:126`, `apps/engine/src/main.ts:213`, `apps/engine/src/main.ts:228`, `apps/engine/src/main.ts:234`, `apps/engine/src/main.ts:256`, `apps/engine/src/main.ts:267`, `apps/engine/src/main.ts:281`, `apps/engine/src/main.ts:290`
- `apps/engine/src/providers/gmail/sync.ts:206`, `apps/engine/src/providers/gmail/sync.ts:325`, `apps/engine/src/providers/gmail/sync.ts:382`
- `apps/engine/src/providers/imap/organise.ts:87`, `apps/engine/src/providers/imap/organise.ts:94`, `apps/engine/src/providers/imap/organise.ts:107`, `apps/engine/src/providers/imap/organise.ts:110`, `apps/engine/src/providers/imap/organise.ts:121`, `apps/engine/src/providers/imap/organise.ts:126`, `apps/engine/src/providers/imap/organise.ts:136`, `apps/engine/src/providers/imap/organise.ts:142`, `apps/engine/src/providers/imap/organise.ts:151`, `apps/engine/src/providers/imap/organise.ts:159`, `apps/engine/src/providers/imap/organise.ts:165`, `apps/engine/src/providers/imap/organise.ts:170`, `apps/engine/src/providers/imap/organise.ts:178`, `apps/engine/src/providers/imap/organise.ts:235`, `apps/engine/src/providers/imap/organise.ts:252`
- `apps/engine/src/sync/manager.ts:228`, `apps/engine/src/sync/manager.ts:380`, `apps/engine/src/sync/manager.ts:401`, `apps/engine/src/sync/manager.ts:416`, `apps/engine/src/sync/manager.ts:463`, `apps/engine/src/sync/manager.ts:471`, `apps/engine/src/sync/manager.ts:597`, `apps/engine/src/sync/manager.ts:598`, `apps/engine/src/sync/manager.ts:607`, `apps/engine/src/sync/manager.ts:740`

### Catches with no error binding

- `apps/cli/src/client.ts:48`
- `apps/cli/src/config.ts:20`
- `apps/cli/src/main.ts:624`
- `apps/cli/src/triage-claude.ts:76`, `apps/cli/src/triage-claude.ts:138`, `apps/cli/src/triage-claude.ts:165`, `apps/cli/src/triage-claude.ts:215`
- `apps/cli/src/triage.ts:181`, `apps/cli/src/triage.ts:440`
- `apps/desktop/electron.vite.config.ts:15`
- `apps/desktop/src/main/auth.ts:36`
- `apps/desktop/src/main/auto-triage.ts:178`
- `apps/desktop/src/main/draft-updates.ts:77`
- `apps/desktop/src/main/engine.ts:65`
- `apps/desktop/src/main/feedback-ipc.ts:96`, `apps/desktop/src/main/feedback-ipc.ts:109`, `apps/desktop/src/main/feedback-ipc.ts:120`, `apps/desktop/src/main/feedback-ipc.ts:132`, `apps/desktop/src/main/feedback-ipc.ts:135`
- `apps/desktop/src/main/handoff.ts:33`
- `apps/desktop/src/main/index.ts:116`, `apps/desktop/src/main/index.ts:130`, `apps/desktop/src/main/index.ts:203`, `apps/desktop/src/main/index.ts:411`, `apps/desktop/src/main/index.ts:526`, `apps/desktop/src/main/index.ts:564`, `apps/desktop/src/main/index.ts:587`, `apps/desktop/src/main/index.ts:636`, `apps/desktop/src/main/index.ts:681`, `apps/desktop/src/main/index.ts:689`, `apps/desktop/src/main/index.ts:1001`
- `apps/desktop/src/main/renderer-load.ts:11`
- `apps/desktop/src/main/replica.ts:144`
- `apps/desktop/src/main/sender-avatars.ts:124`
- `apps/desktop/src/main/sync.ts:93`, `apps/desktop/src/main/sync.ts:136`, `apps/desktop/src/main/sync.ts:162`, `apps/desktop/src/main/sync.ts:169`
- `apps/desktop/src/main/t3-cli.ts:62`, `apps/desktop/src/main/t3-cli.ts:75`, `apps/desktop/src/main/t3-cli.ts:143`, `apps/desktop/src/main/t3-cli.ts:173`
- `apps/desktop/src/main/t3.ts:33`, `apps/desktop/src/main/t3.ts:70`, `apps/desktop/src/main/t3.ts:211`, `apps/desktop/src/main/t3.ts:238`, `apps/desktop/src/main/t3.ts:308`
- `apps/desktop/src/renderer/src/components/organise.tsx:87`
- `apps/desktop/src/renderer/src/components/recipient-field.tsx:36`
- `apps/desktop/src/renderer/src/components/triage-privacy.tsx:39`, `apps/desktop/src/renderer/src/components/triage-privacy.tsx:82`
- `apps/desktop/src/renderer/src/components/triage-status.tsx:25`, `apps/desktop/src/renderer/src/components/triage-status.tsx:45`, `apps/desktop/src/renderer/src/components/triage-status.tsx:74`
- `apps/desktop/src/renderer/src/data/remote-image-preferences.ts:30`, `apps/desktop/src/renderer/src/data/remote-image-preferences.ts:39`
- `apps/desktop/src/renderer/src/features/composer/draft-session.ts:305`
- `apps/desktop/src/renderer/src/features/composer/editor.tsx:30`
- `apps/desktop/src/renderer/src/features/composer/use-composer-session.ts:227`
- `apps/desktop/src/renderer/src/features/feedback/feedback-session.tsx:42`, `apps/desktop/src/renderer/src/features/feedback/feedback-session.tsx:70`, `apps/desktop/src/renderer/src/features/feedback/feedback-session.tsx:72`, `apps/desktop/src/renderer/src/features/feedback/feedback-session.tsx:145`
- `apps/desktop/src/renderer/src/features/mailbox/use-filter-actions.ts:53`
- `apps/desktop/src/renderer/src/features/mailbox/use-inbox-sections.ts:30`, `apps/desktop/src/renderer/src/features/mailbox/use-inbox-sections.ts:122`
- `apps/desktop/src/renderer/src/features/search/use-mail-search.ts:61`
- `apps/desktop/src/renderer/src/features/sender-avatar/cache.ts:103`
- `apps/desktop/src/renderer/src/features/sender-avatar/initials.ts:24`
- `apps/desktop/src/renderer/src/features/thread-list/inbox-sender-actions.tsx:104`
- `apps/desktop/src/renderer/src/features/thread-reader/message-content.tsx:80`
- `apps/desktop/src/renderer/src/features/triage-review/journal.ts:17`
- `apps/desktop/src/renderer/src/features/triage-review/reason-input.tsx:38`
- `apps/desktop/src/renderer/src/features/triage-review/store.ts:90`, `apps/desktop/src/renderer/src/features/triage-review/store.ts:158`, `apps/desktop/src/renderer/src/features/triage-review/store.ts:348`, `apps/desktop/src/renderer/src/features/triage-review/store.ts:742`
- `apps/desktop/src/renderer/src/features/triage-review/use-triage-review.ts:14`
- `apps/desktop/src/renderer/src/hooks/use-theme.ts:11`, `apps/desktop/src/renderer/src/hooks/use-theme.ts:26`
- `apps/engine/src/blobs.ts:75`
- `apps/engine/src/crypto.ts:22`
- `apps/engine/src/db/backups.ts:87`
- `apps/engine/src/db/database.ts:114`
- `apps/engine/src/http/app.ts:99`
- `apps/engine/src/http/buckets.ts:12`
- `apps/engine/src/http/compose.ts:64`
- `apps/engine/src/http/composer-editor.ts:20`
- `apps/engine/src/http/filtered.ts:38`, `apps/engine/src/http/filtered.ts:50`
- `apps/engine/src/http/mail.ts:68`, `apps/engine/src/http/mail.ts:79`, `apps/engine/src/http/mail.ts:110`, `apps/engine/src/http/mail.ts:139`, `apps/engine/src/http/mail.ts:206`
- `apps/engine/src/http/mutations.ts:26`, `apps/engine/src/http/mutations.ts:54`
- `apps/engine/src/http/sender-avatars.ts:37`, `apps/engine/src/http/sender-avatars.ts:50`, `apps/engine/src/http/sender-avatars.ts:92`
- `apps/engine/src/http/senders.ts:41`, `apps/engine/src/http/senders.ts:58`, `apps/engine/src/http/senders.ts:106`
- `apps/engine/src/http/tokens.ts:30`
- `apps/engine/src/http/triage-history.ts:23`
- `apps/engine/src/http/triage-lease.ts:12`, `apps/engine/src/http/triage-lease.ts:27`
- `apps/engine/src/mail/avatars/index.ts:116`
- `apps/engine/src/mail/avatars/network.ts:336`
- `apps/engine/src/mail/avatars/store.ts:43`
- `apps/engine/src/mail/drafts.ts:549`, `apps/engine/src/mail/drafts.ts:1384`, `apps/engine/src/mail/drafts.ts:1392`, `apps/engine/src/mail/drafts.ts:1400`, `apps/engine/src/mail/drafts.ts:1499`
- `apps/engine/src/mail/mutations.ts:2148`
- `apps/engine/src/mail/outbox.ts:219`, `apps/engine/src/mail/outbox.ts:269`
- `apps/engine/src/mail/senders/actions.ts:385`
- `apps/engine/src/mail/senders/destination.ts:291`, `apps/engine/src/mail/senders/destination.ts:329`
- `apps/engine/src/mail/triage/legacy.ts:44`
- `apps/engine/src/mail/triage/purge-maintenance.ts:23`
- `apps/engine/src/mail/triage/queue.ts:40`
- `apps/engine/src/main.ts:124`, `apps/engine/src/main.ts:228`, `apps/engine/src/main.ts:234`, `apps/engine/src/main.ts:289`
- `apps/engine/src/providers/gmail/http.ts:133`
- `apps/engine/src/providers/gmail/mapping.ts:28`
- `apps/engine/src/providers/gmail/oauth.ts:98`
- `apps/engine/src/providers/gmail/pubsub.ts:27`, `apps/engine/src/providers/gmail/pubsub.ts:58`
- `apps/engine/src/providers/imap/client.ts:159`, `apps/engine/src/providers/imap/client.ts:168`
- `apps/engine/src/providers/imap/organise.ts:106`, `apps/engine/src/providers/imap/organise.ts:176`, `apps/engine/src/providers/imap/organise.ts:202`, `apps/engine/src/providers/imap/organise.ts:348`
- `apps/engine/src/providers/imap/provider.ts:121`
- `apps/engine/src/sync/manager.ts:347`
- `packages/protocol/src/smart-inbox.ts:150`

### Other catch call sites to review

- `apps/cli/src/client.ts:40`
- `apps/cli/src/main.ts:643`
- `apps/cli/src/triage-claude.ts:143`
- `apps/cli/src/triage.ts:159`, `apps/cli/src/triage.ts:360`
- `apps/desktop/src/main/auth.ts:16`
- `apps/desktop/src/main/auto-triage.ts:167`
- `apps/desktop/src/main/engine.ts:57`
- `apps/desktop/src/main/handoff.ts:186`
- `apps/desktop/src/main/index.ts:272`, `apps/desktop/src/main/index.ts:381`, `apps/desktop/src/main/index.ts:390`, `apps/desktop/src/main/index.ts:400`, `apps/desktop/src/main/index.ts:525`, `apps/desktop/src/main/index.ts:584`, `apps/desktop/src/main/index.ts:803`, `apps/desktop/src/main/index.ts:1017`, `apps/desktop/src/main/index.ts:1060`
- `apps/desktop/src/main/organise.ts:559`, `apps/desktop/src/main/organise.ts:588`
- `apps/desktop/src/main/renderer-load.ts:33`
- `apps/desktop/src/main/replica.ts:184`
- `apps/desktop/src/main/sync.ts:114`, `apps/desktop/src/main/sync.ts:123`, `apps/desktop/src/main/sync.ts:176`
- `apps/desktop/src/main/t3-cli.ts:103`
- `apps/desktop/src/main/t3.ts:65`, `apps/desktop/src/main/t3.ts:84`, `apps/desktop/src/main/t3.ts:164`, `apps/desktop/src/main/t3.ts:298`
- `apps/desktop/src/main/tray.ts:24`, `apps/desktop/src/main/tray.ts:46`
- `apps/desktop/src/main/triage-process.ts:23`
- `apps/desktop/src/renderer/src/components/agent-activity.tsx:40`
- `apps/desktop/src/renderer/src/components/composer.tsx:97`, `apps/desktop/src/renderer/src/components/composer.tsx:104`
- `apps/desktop/src/renderer/src/components/discard-draft-dialog.tsx:34`
- `apps/desktop/src/renderer/src/components/handoff-dialog.tsx:52`, `apps/desktop/src/renderer/src/components/handoff-dialog.tsx:68`, `apps/desktop/src/renderer/src/components/handoff-dialog.tsx:80`, `apps/desktop/src/renderer/src/components/handoff-dialog.tsx:93`
- `apps/desktop/src/renderer/src/components/mail-settings.tsx:50`, `apps/desktop/src/renderer/src/components/mail-settings.tsx:122`, `apps/desktop/src/renderer/src/components/mail-settings.tsx:146`
- `apps/desktop/src/renderer/src/components/organise.tsx:56`
- `apps/desktop/src/renderer/src/components/pair-screen.tsx:28`
- `apps/desktop/src/renderer/src/data/query-cache.ts:157`
- `apps/desktop/src/renderer/src/features/composer/draft-session.ts:329`, `apps/desktop/src/renderer/src/features/composer/draft-session.ts:348`, `apps/desktop/src/renderer/src/features/composer/draft-session.ts:406`
- `apps/desktop/src/renderer/src/features/composer/use-composer-session.ts:126`, `apps/desktop/src/renderer/src/features/composer/use-composer-session.ts:139`, `apps/desktop/src/renderer/src/features/composer/use-composer-session.ts:157`, `apps/desktop/src/renderer/src/features/composer/use-composer-session.ts:217`, `apps/desktop/src/renderer/src/features/composer/use-composer-session.ts:276`
- `apps/desktop/src/renderer/src/features/delivery/queued-delivery.tsx:66`
- `apps/desktop/src/renderer/src/features/delivery/resolve-delivery.tsx:36`
- `apps/desktop/src/renderer/src/features/delivery/use-delivery-poll.ts:45`
- `apps/desktop/src/renderer/src/features/mailbox/send-undo.ts:56`
- `apps/desktop/src/renderer/src/features/mailbox/use-filter-actions.ts:101`
- `apps/desktop/src/renderer/src/features/mailbox/use-mail-compose.ts:29`, `apps/desktop/src/renderer/src/features/mailbox/use-mail-compose.ts:50`, `apps/desktop/src/renderer/src/features/mailbox/use-mail-compose.ts:79`
- `apps/desktop/src/renderer/src/features/mailbox/use-mail-dialogs.ts:29`
- `apps/desktop/src/renderer/src/features/mailbox/use-thread-actions.ts:34`, `apps/desktop/src/renderer/src/features/mailbox/use-thread-actions.ts:65`
- `apps/desktop/src/renderer/src/features/thread-list/inbox-sender-actions.tsx:110`
- `apps/desktop/src/renderer/src/features/triage-review/queue.ts:21`
- `apps/desktop/src/renderer/src/features/triage-review/store.ts:181`, `apps/desktop/src/renderer/src/features/triage-review/store.ts:379`, `apps/desktop/src/renderer/src/features/triage-review/store.ts:462`, `apps/desktop/src/renderer/src/features/triage-review/store.ts:500`, `apps/desktop/src/renderer/src/features/triage-review/store.ts:541`, `apps/desktop/src/renderer/src/features/triage-review/store.ts:586`, `apps/desktop/src/renderer/src/features/triage-review/store.ts:662`
- `apps/desktop/src/renderer/src/features/triage-review/triage-review.tsx:160`
- `apps/engine/src/config.ts:52`
- `apps/engine/src/db/backups.ts:57`, `apps/engine/src/db/backups.ts:103`
- `apps/engine/src/db/database.ts:33`
- `apps/engine/src/http/agent-actions.ts:24`
- `apps/engine/src/http/composer-link.ts:26`
- `apps/engine/src/http/composer-socket.ts:52`
- `apps/engine/src/http/mail.ts:94`, `apps/engine/src/http/mail.ts:174`, `apps/engine/src/http/mail.ts:227`
- `apps/engine/src/http/mutations.ts:44`
- `apps/engine/src/http/senders.ts:49`
- `apps/engine/src/http/tokens.ts:57`
- `apps/engine/src/mail/agent-actions.ts:130`, `apps/engine/src/mail/agent-actions.ts:153`
- `apps/engine/src/mail/avatars/index.ts:169`
- `apps/engine/src/mail/avatars/network.ts:135`, `apps/engine/src/mail/avatars/network.ts:139`, `apps/engine/src/mail/avatars/network.ts:262`
- `apps/engine/src/mail/avatars/store.ts:74`
- `apps/engine/src/mail/delivery.ts:28`, `apps/engine/src/mail/delivery.ts:88`
- `apps/engine/src/mail/drafts.ts:427`, `apps/engine/src/mail/drafts.ts:968`
- `apps/engine/src/mail/mutations.ts:341`, `apps/engine/src/mail/mutations.ts:1317`, `apps/engine/src/mail/mutations.ts:1405`, `apps/engine/src/mail/mutations.ts:1594`, `apps/engine/src/mail/mutations.ts:2207`, `apps/engine/src/mail/mutations.ts:2358`, `apps/engine/src/mail/mutations.ts:2390`, `apps/engine/src/mail/mutations.ts:2446`
- `apps/engine/src/mail/senders/destination.ts:98`, `apps/engine/src/mail/senders/destination.ts:168`, `apps/engine/src/mail/senders/destination.ts:210`, `apps/engine/src/mail/senders/destination.ts:232`
- `apps/engine/src/mail/triage/erasure.ts:58`
- `apps/engine/src/mail/triage/purge-worker.ts:10`
- `apps/engine/src/main.ts:306`
- `apps/engine/src/mcp/server.ts:505`, `apps/engine/src/mcp/server.ts:576`, `apps/engine/src/mcp/server.ts:659`
- `apps/engine/src/providers/gmail/http.ts:118`, `apps/engine/src/providers/gmail/http.ts:236`, `apps/engine/src/providers/gmail/http.ts:262`, `apps/engine/src/providers/gmail/http.ts:278`, `apps/engine/src/providers/gmail/http.ts:299`, `apps/engine/src/providers/gmail/http.ts:385`, `apps/engine/src/providers/gmail/http.ts:412`
- `apps/engine/src/providers/gmail/oauth.ts:26`
- `apps/engine/src/providers/imap/client.ts:141`
- `apps/engine/src/providers/imap/mapping.ts:158`
- `apps/engine/src/providers/imap/organise.ts:73`
- `apps/engine/src/providers/imap/provider.ts:107`
- `apps/engine/src/providers/imap/sync.ts:40`, `apps/engine/src/providers/imap/sync.ts:105`, `apps/engine/src/providers/imap/sync.ts:230`
- `apps/engine/src/sync/manager.ts:212`, `apps/engine/src/sync/manager.ts:427`, `apps/engine/src/sync/manager.ts:465`, `apps/engine/src/sync/manager.ts:503`, `apps/engine/src/sync/manager.ts:541`, `apps/engine/src/sync/manager.ts:649`, `apps/engine/src/sync/manager.ts:717`

## Phase 2 implementation checklist

Use the baseline line indexes above to locate catches after rebase. Each slice owns the files listed below and its event registry fragment. Use the shared envelope and IDs in every slice.

### A. Engine

- [ ] Own `apps/engine/src/{main,log,accounts}.ts`, `http/**`, `db/**`, `sync/**`, `providers/**`, `mail/**` and the Engine deploy/unit files. Replace Pino and service console call sites in the index. Separate interactive management command output from the service journal, and instrument deploy migrations, backups and startup with fixed stages. Configure journal retention in provisioning and update the runbook.
- [ ] Instrument sync cycles, Gmail history/backfill and Pub/Sub pull/ack, IMAP IDLE connect/reconnect and writeback, purge worker, Outbox, mutation retries and WebSocket/SSE interruption. Add `sync.cycle.failed`, `sync.imap.idle.reconnect`, `sync.gmail.pubsub.failed`, `purge.job.failed`, and `deploy.migration.failed` and matching recovery/success events to `engine-events.ts`. Review no-binding and handled catches under Engine, especially `sync/manager.ts`, `providers/{gmail,imap}/`, `mail/{drafts,outbox,triage}/`, and `main.ts`. Route provider and database errors through the sanitizer, keeping retry counts and fixed error classifications.
- [ ] Own the authorization, projection and mount for `/v1/diagnostics` in `http/diagnostics.ts` and `http/app.ts`. Publish the response type and validator as a dedicated file under `packages/protocol/src/`. A owns the protocol export and any shared `errors.ts` catalog additions. Tests cover unauthenticated, Agent, owner, restart and unknown-state behavior. C owns tool callbacks under `mcp/` and uses the transport correlation A exposes on Hono's context.

### B. Desktop main and renderer

- [ ] Own `apps/desktop/src/main/` except the feedback modules named in C, plus preload, shared IPC types and renderer except `features/feedback/`. Send Engine IDs from `main/engine.ts`, pairing in `main/index.ts`, and any direct HTTP implementation. Wire runtime/window/React and IPC reports through preload with main-frame checks and backpressure. Add Desktop debug settings and a main-owned logger for each Desktop component.
- [ ] Instrument `main/{sync,organise,triage-process,triage-worker,auto-triage,handoff,draft-updates,renderer-load,replica,auth}.ts` and associated UI failure Details. Add `desktop.sync.failed`, `desktop.ipc.failed`, `triage.run.failed`, `handoff.failed`, and their start or recovery markers to `desktop-events.ts`. Review Desktop main and renderer catches in the index, with special attention to recovery loops and user-facing toasts. Rebase the concurrent triage fix before integrating with `auto-triage.ts` and `components/triage-status.tsx`.
- [ ] Own the menu and IPC wiring for **Copy diagnostics**. Use the sanitized reader C provides. Wire the Engine request and use C's snapshot contract with A's dedicated projection. Keep screenshot feedback capture and launch code in C.

### C. CLI, MCP and feedback excerpt

- [ ] Own `apps/cli/src/`, `apps/engine/src/mcp/`, `apps/desktop/src/main/{feedback,feedback-ipc}.ts` and `apps/desktop/src/renderer/src/features/feedback/`. Wire `smart-inbox.ts` and AMC-owned MCP client fetch hooks to the request ID helper. Direct external MCP clients without an ID use Engine's fallback. Coordinate T3 transport changes in `main/t3.ts` with B, which owns that file. Wrap command and tool failures with operation/command/tool enums, request ID, run ID where available, status and classified error. Review `cli/{client,config,main,triage,triage-claude,smart-inbox}.ts`, MCP handler catches and the Desktop feedback catches. Add `cli.command.failed`, `mcp.tool.failed`, `feedback.launch.started`, and `feedback.launch.finished` to `client-events.ts`. Preserve MCP transport framing and current scope checks. Keep host MCP records in the Engine journal and Mac-side MCP records in `mcp.log`.
- [ ] Implement `amc logs`, `amc diagnostics`, and a schema-projecting local log reader for CLI and Desktop via `packages/observability/src/local-reader.ts`. Export the verified reader through a new subpath or a direct file export in coordination with B. Test rotated files, filters, time windows, unavailability, and canaries injected into legacy, malformed and structured-looking lines. Provide single-writer coordination for the Mac CLI/MCP rotation path.
- [ ] Implement the feedback excerpt in the existing capture and cleanup lifecycle. Keep `registerFeedbackIpc`'s existing call site compatible. Pass local file paths only. Test stale/expired captures, sanitized file contents, path inclusion and cleanup. Expose the bounded reader and snapshot assembly for B's **Copy diagnostics** menu and IPC.
