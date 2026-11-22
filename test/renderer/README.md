# Renderer regression harness

Run `pnpm exec vitest run --project renderer` or `pnpm check`. Set
`AMC_RENDERER_COUNTS=1` to print the measured ledger for each budget checkpoint.

The suite mounts the production `App` in React Strict Mode with a typed,
synthetic `window.amc`. The adapter clones read replies and can resolve them in
separate `act` calls to model IPC tasks. jsdom uses a fixed list viewport and
fake timers. For body input the test makes the DOM change that a browser would
make and lets ProseMirror's mutation observer handle it. Browser layout, native
editing, IPC latency, and frame timing require a separate Electron run.

## Adding a budget

1. Mount and settle the production entry point before clearing the commit ledger.
2. Deliver one event in `act`. Resolve delayed replies in separate `act` calls
   and advance fake time only when the scenario exercises a timer.
3. Assert visible content, selection, focus, and node identity as appropriate.
   These assertions catch updates that are accidentally dropped.
4. Add an `expectBudget` ceiling for the affected regions and record the
   observed counts here. Where the audit target is lower, keep a Phase 2
   `it.todo` until the target can be enforced. For failure and resnapshot, add
   `expectContinuity` at each checkpoint when retention lands.

`profile-plugin.ts` inserts test-only React Profiler boundaries around the
tracked components' return values. Each boundary counts its new render output
once, even if a descendant later commits on its own. Row counts use thread IDs.
When the inline row body or footer is extracted, move its probe inside the
extracted component so it measures content rather than the position or parent
wrapper. The mount checks detect missing probes.

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
