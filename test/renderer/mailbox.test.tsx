import { act, fireEvent, screen, within } from '@testing-library/react'
import { expect, it } from 'vitest'
import { deferred } from './adapter'
import { commits, expectBudget } from './profile'
import {
  firstSubject,
  listbox,
  mount,
  options,
  reader,
  row,
  selected,
  threadCount,
} from './workspace'

const secondSubject = 'Sunday at the studio'

function mailboxNodes(subject = firstSubject) {
  const list = listbox()
  const rows = options()
  const heading = reader(subject)
  const selection = selected()
  act(() => list.focus())
  return { list, rows, heading, selection }
}

function expectContinuity(before: ReturnType<typeof mailboxNodes>, subject = firstSubject) {
  expect(listbox()).toBe(before.list)
  for (const node of before.rows) expect(options()).toContain(node)
  expect(reader(subject)).toBe(before.heading)
  expect(selected()).toBe(before.selection)
  expect(listbox().getAttribute('aria-activedescendant')).toBe(before.selection.id)
  expect(document.activeElement).toBe(before.list)
}

it('preserves the mailbox on a status-only timestamp change', async () => {
  const adapter = await mount()
  const before = mailboxNodes()
  adapter.api.threads.mockClear()
  await act(async () => adapter.emitStatus({ lastSyncAt: Date.now() + 1000 }))
  expect(adapter.api.threads).not.toHaveBeenCalled()
  expectContinuity(before)
  expectBudget({ app: 1, workspace: 1, sidebar: 1, list: 1, reader: 1, rows: 1 })
})

it.each(['immediate', 'staggered'] as const)(
  'preserves mailbox nodes on a cloned no-op sync event with %s replies',
  async (timing) => {
    const adapter = await mount()
    const before = mailboxNodes()
    const queries = [
      adapter.api.accounts,
      adapter.api.labels,
      adapter.api.counts,
      adapter.api.threads,
      adapter.api.thread,
      adapter.api.activeHandoff,
      adapter.api.triageCounts,
      adapter.api.organiseErrors,
    ]
    for (const query of queries) query.mockClear()
    const release = timing === 'staggered' ? adapter.staggerReads() : undefined
    await act(async () => adapter.emitChanged())
    for (const resolve of release?.() ?? []) {
      await act(async () => resolve())
      expectContinuity(before)
    }
    for (const query of queries) expect(query).toHaveBeenCalledTimes(1)
    expectContinuity(before)
    const region = timing === 'staggered' ? 7 : 2
    expectBudget({
      app: 0,
      workspace: region,
      sidebar: timing === 'staggered' ? 8 : 2,
      list: region,
      reader: region,
      rows: region,
    })
  },
)

it('applies one off-reader bucket change to the existing row', async () => {
  const adapter = await mount()
  const before = mailboxNodes()
  const changed = options()[1]
  expect(within(changed).queryByText('Later')).toBeNull()
  await act(async () => {
    await adapter.api.setBucket({ threadId: 'thread-2', bucket: 'Later', reason: 'Synthetic edit' })
  })
  expect(within(changed).getByText('Later')).toBeTruthy()
  expect(options()).toEqual(before.rows)
  expectContinuity(before)
  expectBudget({ workspace: 2, list: 2, reader: 2, rows: 2 })
})

it('reorders existing rows while retaining selection and focus by thread', async () => {
  const adapter = await mount()
  const before = mailboxNodes()
  const source = await adapter.api.threads({ view: { kind: 'inbox' }, accountId: null })
  const [first, second, ...rest] = source
  const stale = deferred<typeof source>()
  adapter.api.threads.mockReturnValueOnce(stale.promise)
  await act(async () => adapter.emitChanged())
  expectContinuity(before)
  commits.clear()

  adapter.api.threads.mockResolvedValueOnce([
    { ...second, lastMessageAt: first.lastMessageAt + 1 },
    first,
    ...rest,
  ])
  await act(async () => adapter.emitChanged())
  expect(options()).toEqual([before.rows[1], before.rows[0], ...before.rows.slice(2)])
  expectContinuity(before)
  expectBudget({ workspace: 2, list: 2, reader: 2, rows: 2 })

  commits.clear()
  await act(async () => stale.resolve(source))
  expect(options()).toEqual([before.rows[1], before.rows[0], ...before.rows.slice(2)])
  expectContinuity(before)
  expectBudget({ list: 0, reader: 0, rows: 0 })
})

it('recovers from a same-key list failure and keeps the reader through a pending retry', async () => {
  const adapter = await mount()
  const before = mailboxNodes()
  adapter.api.threads.mockRejectedValueOnce(new Error('Synthetic list failure'))
  await act(async () => adapter.emitChanged())
  expect(screen.getByText('Could not load threads')).toBeTruthy()
  expect(reader()).toBe(before.heading)
  // If the renderer keeps the list through the error, reject replacement DOM.
  const retainedList = screen.queryByRole('listbox', { name: 'Threads' })
  if (retainedList) expectContinuity(before)
  expectBudget({ workspace: 2, reader: 2 })

  const source = await adapter.api.threads({ view: { kind: 'inbox' }, accountId: null })
  const retry = deferred<typeof source>()
  adapter.api.threads.mockReturnValueOnce(retry.promise)
  commits.clear()
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Retry' })))
  expect(reader()).toBe(before.heading)
  await act(async () => retry.resolve(source))
  expect(options()).toHaveLength(threadCount)
  expect(selected()).toBe(row(firstSubject))
  expect(reader()).toBe(before.heading)
  expect(screen.queryByText('Could not load threads')).toBeNull()
  if (retainedList) expect(listbox()).toBe(before.list)
  expectBudget({ workspace: 2, list: 3, reader: 2, rows: 2 })
})

it('recovers the Inbox after an empty page during a same-pairing resnapshot', async () => {
  const adapter = await mount()
  await act(async () => fireEvent.click(row(secondSubject)))
  const before = mailboxNodes(secondSubject)
  commits.clear()
  // Reads may be deferred during bootstrap. Only serve partial data during that phase.
  await adapter.api.threads.withImplementation(
    async () => [],
    async () => {
      await adapter.api.thread.withImplementation(
        async () => null,
        async () => {
          await act(async () => {
            adapter.emitStatus({ phase: 'bootstrapping', progress: 0 })
            adapter.emitChanged()
          })
        },
      )
    },
  )
  const retainedList = screen.queryByRole('listbox', { name: 'Threads' })
  if (retainedList) expectContinuity(before, secondSubject)
  expectBudget({ workspace: 3, reader: 3 })
  commits.clear()
  await act(async () => {
    adapter.emitChanged()
    adapter.emitStatus({ phase: 'live', progress: null })
  })
  expect(options()).toHaveLength(threadCount)
  const selectedSubject = selected().textContent?.includes(secondSubject)
    ? secondSubject
    : firstSubject
  expect(selected()).toBe(row(selectedSubject))
  expect(reader(selectedSubject).isConnected).toBe(true)
  if (retainedList) expectContinuity(before, secondSubject)
  expectBudget({ workspace: 4, list: 4, reader: 4, rows: 3 })
})

it.todo(
  'Phase 2: a timestamp-only status event commits zero workspace, list, reader or composer regions',
)
it.todo(
  'Phase 2: an immediate or staggered no-op event commits zero list, row, reader or composer regions',
)
it.todo(
  'Phase 2: an off-reader change commits the changed row once and zero sibling, reader or composer regions',
)
it.todo('Phase 2: same-key failure and retry retain the listbox, every row, focus and selection')
it.todo(
  'Phase 2: a same-pairing resnapshot retains the listbox, rows, reader, focus and selected thread',
)
