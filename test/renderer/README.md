# Renderer regression harness

Run `pnpm exec vitest run --project renderer` or `pnpm check`. Set
`AMC_RENDERER_COUNTS=1` to print the measured ledger for each budget checkpoint.

The suite mounts the production `App` in React Strict Mode with a typed,
synthetic `window.amc`. The adapter clones read replies and can resolve them in
separate `act` calls to model IPC tasks. jsdom uses a fixed list viewport and
fake timers. For body input the test makes the DOM change that a browser would
make and lets ProseMirror's mutation observer handle it. Browser layout, native
editing, IPC latency, and frame timing require a separate Electron run.

Run `pnpm test:html-reader` for the HTML message layout and input suite. It
mounts the development renderer with synthetic mail in an isolated Electron
profile and uses a loopback image endpoint to exercise AMC's request policy.
`pnpm verify` runs it on macOS in both scrollbar modes. To run one mode
directly, append `-AppleShowScrollBars Always` or
`-AppleShowScrollBars WhenScrolling` to check classic or overlay scrollbars
without changing the system preference.

## Adding a budget

1. Mount and settle the production entry point before clearing the commit ledger.
2. Deliver one event in `act`. Resolve delayed replies in separate `act` calls
   and advance fake time only when the scenario exercises a timer.
3. Assert visible content, selection, focus, and node identity as appropriate.
   These assertions catch updates that are accidentally dropped.
4. Add an `expectBudget` ceiling for the affected regions and record the
   observed counts here. Assert the exact changed row IDs when the scenario
   should update only particular rows. For failure and resnapshot, check
   `expectContinuity` at each checkpoint.

`profile-plugin.ts` inserts test-only React Profiler boundaries around the
return values of tracked components found by name in renderer exports. Each
boundary counts its new render output once, even if a descendant later commits
on its own. The subscribed row supplies its thread ID to the probe inside the memoized
`ThreadRow` body. The inline composer footer has its own probe. The
mount checks detect missing probes and verify that row counts use the mounted
thread IDs.

## Baseline

Production source at `dc8d21b`, eight synthetic rows. Row totals are the sum of
per-thread committed bodies. The immediate adapter and local defaults can
settle in separate commits in jsdom, so these counts differ from the Electron
audit.

| Settled action | App | Workspace | Sidebar | List | Row bodies | Reader | Composer | Recipient | Footer |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Status timestamp | 1 | 1 | 1 | 1 | 8 | 1 | 0 | 0 | 0 |
| No-op replica, immediate | 0 | 2 | 2 | 2 | 16 | 2 | 0 | 0 | 0 |
| No-op replica, staggered | 0 | 7 | 8 | 7 | 56 | 7 | 0 | 0 | 0 |
| Off-reader bucket edit | 0 | 2 | 2 | 2 | 16 | 2 | 0 | 0 | 0 |
| Reorder with an older read pending | 0 | 2 | 2 | 2 | 16 | 2 | 0 | 0 | 0 |
| Late reply to older read | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| List failure | 0 | 2 | 2 | 0 | 0 | 2 | 0 | 0 | 0 |
| Retry of failed list | 0 | 2 | 2 | 3 | 16 | 2 | 0 | 0 | 0 |
| Resnapshot, empty page | 1 | 3 | 3 | 3 | 0 | 3 | 0 | 0 | 0 |
| Resnapshot, completed | 1 | 4 | 4 | 4 | 24 | 4 | 0 | 0 | 0 |
| No-op replica with composer | 0 | 2 | 2 | 2 | 16 | 2 | 2 | 2 | 2 |
| Subject or body character | 0 | 0 | 0 | 0 | 0 | 0 | 1 | 1 | 1 |
| One unchanged draft poll | 0 | 0 | 0 | 0 | 0 | 0 | 1 | 1 | 1 |

The failed refresh detaches the listbox and all eight rows. Retrying replaces
the rows and preserves the reader. The empty resnapshot detaches all eight
rows and resets the selection from the second thread to the first. See
[the audit](../../docs/desktop-react-audit.md#keep-it-that-way) for Phase 2 targets.

## Selector integration

Before counts come from Phase 1 main at `8bf447d`. The columns show committed
renders. Count badges and the Inbox total have their own subscriptions.

| Settled action | Workspace before → after | List before → after | Row bodies before → after | Reader before → after | Composer before → after |
| --- | ---: | ---: | ---: | ---: | ---: |
| Status timestamp | 1 → 0 | 1 → 0 | 0 → 0 | 1 → 0 | Closed |
| No-op replica, immediate or staggered | 0 → 0 | 0 → 0 | 0 → 0 | 0 → 0 | Closed |
| No-op replica with composer | 0 → 0 | 0 → 0 | 0 → 0 | 0 → 0 | 0 → 0 |
| Off-reader bucket edit | 1 → 0 | 1 → 0 | 1 → 1 | 1 → 0 | Closed |
| Same-key list failure | 1 → 0 | 1 → 0 | 0 → 0 | 1 → 0 | Closed |
| Same-key list retry | 1 → 0 | 1 → 0 | 0 → 0 | 1 → 0 | Closed |

The timestamp test records one sync indicator commit. The open-composer
variants record zero composer, recipient and footer commits. The resnapshot
test keeps all eight rows, reader, focus and selection through the partial
replica and the return to live. The composer typing and unchanged-poll TODOs
belong to the composer session refactor in PR #141.

## Sectioned Inbox

The harness verifies Bucket catalog order, custom Bucket rename and reorder,
Account-scoped collapse after restart, Sender grouping, notification-open,
keyboard focus, and the scroll anchor when an earlier section collapses. The large fixture
indexes 5,105 Threads and mounts fewer than 40 options.

| Settled action | Workspace | List | Section headings | Changed row | Sibling rows | Reader | Composer |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Off-reader move from Action to Follow-up | 0 | 1 | 2 | 1 | 0 | 0 | 0 |
| Staggered cloned reply after the move | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| Off-reader cross-section move with composer open | 0 | 1 | 2 | 1 | 0 | 0 | 0 |
| Same-key failure and retry | 0 | 0 | 0 | 0 | 0 | 0 | 0 |

Section membership comes from the query-local index. The list owns changes to
row geometry and headers subscribe to their counts. The cross-section test
checks the actual row, listbox, selection, reader and focus nodes in addition
to the commit budget.

## Desktop triage review

The Engine owns queue eligibility, Thread revisions, and provider outcomes.
The renderer review store owns the ordered card IDs, position, and action
journal, saved under the pairing and Account for exact Undo. Every entry reads
the live Engine queue and starts with no skips. The review appends newly eligible
cards on replica changes and checks the Engine again at the end. Inbox and
triage group New Senders by Account and address. Triage can also include Bucket
and filter cards, and its progress counts cards in the current review. The card, progress, and history subscribe
to their own snapshots. Organise owns local Archive and Snooze writeback.

| Settled action | Review card | Progress | Workspace | Sidebar | List | Row bodies | Reader | Composer |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Space skips to a validated next card | 1 | 1 | 0 | 0 | 0 | 0 | 0 | 0 |
| Replica change appends a card to the queue | 0 | 1 | 0 | 0 | 0 | 0 | 0 | 0 |

The App harness covers focus return, fresh entry after All clear and restart, Account switching
during an older read, notification-open, stale cards, retry and empty states,
Handoff, representative Thread targeting, and exact Undo. It also exercises
the real composer and checks that an explicit Send keeps the Outbox ID.

An offscreen Electron 45.4.1 run used the production App at 1280 × 900,
a fresh temporary profile, forced reduced motion, and 100,000 synthetic Inbox
Threads. There were 21 mounted options and one review card. Review entry and
six Space keypresses took 0.8–16.6 ms from the keydown to the animation frame
after the progress update. During a scroll sample, 29 of 30 animation-frame
intervals were 16.6–16.8 ms and one was 50 ms. Reply opened the composer,
minimising kept the card, and Esc restored focus to the listbox. This measures
local renderer behavior with in-memory replies.

The automated Engine and CLI suites cover provider fakes, exact-message
Screened out writeback and recovery, notification suppression, and queue JSON.
Live Gmail and IMAP Accounts, fresh Host pairing, VoiceOver, network capture,
and the Host migration and rollback drill still require verification.

## Sender avatars

The production Inbox fixture renders 48 Threads with a New senders card.
Its delayed avatar batch contains the card's representative incoming message
and the thread rows in the visible range. Scrolling requests the newly visible
range and excludes overscan and the off-screen selected row that stays mounted.
Opening an already visible Thread adds zero avatar requests.

| Settled action | Workspace | List | Card and row bodies | Reader | Composer | Changed avatar | Other avatars |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| New senders logo resolves | 0 | 0 | 0 | 0 | 0 | 1 | 0 |

The scenario checks the same 32×32 slot before and after the logo arrives,
plus DOM identity for the rows, selection, and reader.

The triage harness also covers Filter out, exact Undo, the Filtered count and restore action, and inline reasons for Filter out and Block sender. Typing a reason has a budget of zero workspace, list, reader, and review card commits.

## Inbox Archive advance

The production keyboard Archive path uses controlled replies for the Inbox
list, successor detail and first expanded body. On `3d49081`, the old reader
remained while the Inbox reply was pending. Releasing the list selected the
successor and showed “Loading thread.” Releasing detail then showed the
message body skeleton until the HTML reply arrived.

With lookahead, one successor detail read and one local HTML cache read settle
before Archive. Both preparation replies produce zero Workspace, list, row,
and reader commits. Releasing just the Inbox reply selects the successor and
renders its body while both revalidation replies are still pending. The
listbox, surviving row and focus keep their DOM identity. Preparation issues
zero Engine-backed HTML or inline attachment requests and mounts zero message
frames. The cloned no-op Inbox test permits one additional local detail read
for the active successor and keeps the zero-commit budget.
