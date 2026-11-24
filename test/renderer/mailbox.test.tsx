import { act, fireEvent, screen, within } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import { deferred, rendererAdapter } from './adapter'
import { commitCounts, commits, expectBudget } from './profile'
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

function compactViewport() {
  const query = new EventTarget()
  const matchMedia = window.matchMedia
  let compact = false
  vi.stubGlobal('matchMedia', (media: string) =>
    media === '(width < 1000px)' ? Object.assign(query, { matches: compact }) : matchMedia(media),
  )
  return () => {
    compact = true
    act(() => query.dispatchEvent(new Event('change')))
  }
}

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

const idleMailbox = {
  app: 0,
  workspace: 0,
  sidebar: 0,
  indicator: 0,
  list: 0,
  reader: 0,
  composer: 0,
  rows: 0,
}

it('preserves the mailbox on a status-only timestamp change', async () => {
  const adapter = await mount()
  const before = mailboxNodes()
  adapter.api.threads.mockClear()
  await act(async () => adapter.emitStatus({ lastSyncAt: Date.now() - 25_000 }))
  expect(screen.getByText('Up to date · 25s ago')).toBeTruthy()
  expect(adapter.api.threads).not.toHaveBeenCalled()
  expectContinuity(before)
  expectBudget({ ...idleMailbox, indicator: 1 })
  expect(commitCounts().indicator).toBe(1)
})

it('commits only the indicator during a no-op Check for New Mail', async () => {
  const adapter = await mount()
  const before = mailboxNodes()
  adapter.api.threads.mockClear()

  await act(async () =>
    adapter.emitStatus({ mailCheck: 'checking', mailCheckStartedAt: Date.now() }),
  )
  const label = screen.getByText('Checking for new mail…')
  expectContinuity(before)
  expectBudget({ ...idleMailbox, indicator: 1 })

  const trigger = label.closest<HTMLElement>('[data-slot="tooltip-trigger"]')
  expect(trigger?.tabIndex).toBe(0)
  if (!trigger) throw new Error('Expected a mail check tooltip trigger')
  act(() => trigger.focus())
  expect(screen.getByRole('tooltip').textContent).toContain('Waiting for the Engine')
  await act(async () => vi.advanceTimersByTimeAsync(10_000))
  expect(screen.getByRole('tooltip').textContent).toContain('10s elapsed')

  await act(async () => adapter.emitStatus({ mailCheck: 'updating' }))
  expect(screen.getByText('Updating mailbox…').closest('[data-slot="tooltip-trigger"]')).toBe(
    trigger,
  )
  expect(screen.getByRole('tooltip').textContent).toContain('Applying sync changes')
  expect(screen.getByRole('tooltip').textContent).toContain('10s elapsed')
  expect(document.activeElement).toBe(trigger)

  act(() => before.list.focus())
  await act(async () =>
    adapter.emitStatus({
      mailCheck: undefined,
      mailCheckStartedAt: undefined,
      lastSyncAt: Date.now(),
    }),
  )
  expect(screen.getByText('Up to date · just now')).toBeTruthy()
  expect(screen.queryByRole('tooltip')).toBeNull()
  expect(adapter.api.threads).not.toHaveBeenCalled()
  expectContinuity(before)
  expectBudget({ ...idleMailbox, indicator: 4 })
})

it.each(['immediate', 'staggered'] as const)(
  'preserves mailbox nodes on a cloned no-op sync event with %s replies',
  async (timing) => {
    const adapter = await mount()
    await openSidebarTriage()
    const before = mailboxNodes()
    const queries = [
      adapter.api.accounts,
      adapter.api.labels,
      adapter.api.counts,
      adapter.api.threads,
      adapter.api.activeHandoff,
      adapter.api.triageCounts,
      adapter.api.organiseErrors,
    ]
    for (const query of queries) query.mockClear()
    adapter.api.thread.mockClear()
    const release = timing === 'staggered' ? adapter.staggerReads() : undefined
    await act(async () => adapter.emitChanged())
    for (const resolve of release?.() ?? []) {
      await act(async () => resolve())
      expectContinuity(before)
    }
    for (const query of queries) expect(query).toHaveBeenCalledTimes(1)
    expect(adapter.api.thread.mock.calls).toEqual([['thread-1'], ['thread-2']])
    expectContinuity(before)
    expectBudget(idleMailbox)
  },
)

it('shows sections for the selected Bucket without replacing the Thread or message', async () => {
  const adapter = await mount()
  const before = mailboxNodes()
  const scroll = before.heading.closest<HTMLElement>('.overflow-y-auto')
  if (!scroll) throw new Error('Expected the reader scroll container')
  const view = within(scroll)
  expect(view.getByText('Triage')).toBeTruthy()
  const message = () => view.getByRole('button', { name: /Mina/, expanded: true })
  const messageButton = message()
  const body = view.getByText(/Could you approve the warm grey/)
  const context = 'The printer sent a proof for Field Notes.'
  const action = 'Approve the warm grey by Thursday.'
  const setBucket = (
    bucket: Parameters<typeof adapter.api.setBucket>[0]['bucket'],
    reason: string,
  ) => act(async () => adapter.api.setBucket({ threadId: 'thread-1', bucket, reason }))

  expect(
    view.getByText('Mina needs your approval on the print proof before Thursday.'),
  ).toBeTruthy()
  expect(view.queryByRole('term')).toBeNull()
  scroll.scrollTop = 48

  const structured = `Context: ${context} | Action: ${action}`
  await setBucket('Reply', structured)
  expect(view.getByText('Reply')).toBeTruthy()
  expect(view.getAllByRole('term').map((term) => term.textContent)).toEqual(['Context', 'Action'])
  const contextText = view.getByText(context, { selector: 'dd' })
  const actionText = view.getByText(action, { selector: 'dd' })
  expect(actionText.compareDocumentPosition(body) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  expectContinuity(before)
  expect(message()).toBe(messageButton)
  expect(view.getByText(/Could you approve the warm grey/)).toBe(body)
  expect(scroll.scrollTop).toBe(48)

  commits.clear()
  await act(async () => adapter.emitChanged())
  expect(view.getByText(context)).toBe(contextText)
  expect(view.getByText(action)).toBe(actionText)
  expectBudget(idleMailbox)

  await setBucket('Reply', `Context: ${context}`)
  expect(view.getAllByRole('term').map((term) => term.textContent)).toEqual(['Context'])
  expect(view.getByText(context)).toBe(contextText)

  for (const reason of ['See the note. Action: compare the samples.', 'Context: Proof | Action:']) {
    await setBucket('Reply', reason)
    expect(view.getByText(reason, { selector: 'p' })).toBeTruthy()
    expect(view.queryByRole('term')).toBeNull()
  }
  expectContinuity(before)

  for (const bucket of ['Update', 'Later', 'When I have time', 'Newsletters'] as const) {
    await setBucket(bucket, structured)
    expect(view.getByText(bucket)).toBeTruthy()
    expect(view.getByText(context, { selector: 'p' })).toBeTruthy()
    expect(view.queryByText(action)).toBeNull()
    expect(view.queryByRole('term')).toBeNull()
  }
  await setBucket('Update', `Context: ${context}`)
  expect(view.getByText(context, { selector: 'p' })).toBeTruthy()
  await setBucket('Update', 'The printer moved delivery to Friday.')
  expect(view.getByText('The printer moved delivery to Friday.', { selector: 'p' })).toBeTruthy()

  await setBucket('Follow-up', structured)
  expect(view.getAllByRole('term').map((term) => term.textContent)).toEqual([
    'Context',
    'Next step',
  ])
  expect(view.getByText(action, { selector: 'dd' })).toBeTruthy()

  await setBucket('Action', structured)
  expect(view.getAllByRole('term').map((term) => term.textContent)).toEqual(['Context', 'Action'])
  expect(view.getByText(action, { selector: 'dd' })).toBeTruthy()
  expect(listbox()).toBe(before.list)
  expect(document.activeElement).toBe(before.list)
  expect(reader(firstSubject)).toBe(before.heading)
  expect(selected()).toBe(row(firstSubject))
  expect(message()).toBe(messageButton)
  expect(scroll.scrollTop).toBe(48)
})

it('keeps the focused reader and its mailbox stable during staggered no-op sync', async () => {
  const adapter = await mount()
  const before = mailboxNodes()
  const scroll = before.heading.closest('.overflow-y-auto')
  expect(scroll).not.toBeNull()
  adapter.api.thread.mockClear()
  fireEvent.keyDown(before.list, { key: 'o' })
  expect(document.activeElement).toBe(scroll)
  expect(before.list.closest('[inert]')).not.toBeNull()
  expect(adapter.api.thread).not.toHaveBeenCalled()
  expectBudget({ app: 0, workspace: 1, sidebar: 1, list: 1, reader: 1, composer: 0, rows: 0 })

  commits.clear()
  const release = adapter.staggerReads()
  await act(async () => adapter.emitChanged())
  for (const resolve of release()) {
    await act(async () => resolve())
    expect(document.activeElement).toBe(scroll)
    expect(reader()).toBe(before.heading)
  }
  expectBudget(idleMailbox)

  fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' })
  expectContinuity(before)
})

it('hands focus from the command palette to the reader and back to the mailbox', async () => {
  await mount()
  const before = mailboxNodes()
  const scroll = before.heading.closest('.overflow-y-auto')
  expect(scroll).not.toBeNull()
  const command = (name: string) => {
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'k', metaKey: true })
    fireEvent.click(within(screen.getByRole('dialog')).getByText(name))
    expect(screen.queryByRole('dialog')).toBeNull()
    act(() => vi.advanceTimersByTime(0))
  }

  command('Focus reader')
  expect(before.list.closest('[inert]')).not.toBeNull()
  expect(document.activeElement).toBe(scroll)
  command('Back to mailbox')
  expectContinuity(before)
})

it('opens a compact notification during loading and keeps Back available after a failure', async () => {
  const adapter = rendererAdapter()
  const target = (await adapter.api.thread('thread-3'))?.thread
  if (!target) throw new Error('Expected notification thread')
  let notify: ((thread: NonNullable<typeof target>) => void) | undefined
  adapter.api.onOpenThread = (callback) => {
    notify = callback
    return () => {
      notify = undefined
    }
  }
  const narrow = compactViewport()
  await mount(adapter)
  const list = listbox()
  narrow()
  expect(screen.queryByRole('heading', { name: firstSubject, level: 1 })).toBeNull()

  const failure = deferred<void>()
  adapter.api.thread.mockImplementationOnce(async () => {
    await failure.promise
    throw new Error('Synthetic detail read failed')
  })
  await act(async () => notify?.(target))
  const back = screen.getByRole('button', { name: 'Back to mailbox' })
  expect(screen.getByText('Loading thread')).toBeTruthy()
  await act(async () => failure.resolve())
  expect(screen.getByText('Could not open this thread')).toBeTruthy()
  expect(screen.getByRole('button', { name: 'Back to mailbox' })).toBe(back)

  const late = deferred<Awaited<ReturnType<typeof adapter.api.thread>>>()
  const detail = await adapter.api.thread(target.id)
  adapter.api.thread.mockReturnValueOnce(late.promise)
  await act(async () => fireEvent.click(screen.getAllByRole('button', { name: 'Retry' })[0]))
  fireEvent.click(back)
  await act(async () => late.resolve(detail))
  expect(listbox()).toBe(list)
  expect(document.activeElement).toBe(list)
  expect(selected()).toBe(row(target.subject))
  expect(screen.queryByRole('heading', { name: target.subject, level: 1 })).toBeNull()
})

it('opens the exact sent delivery while its row is missing from Sent', async () => {
  const adapter = rendererAdapter()
  const [delivery] = await adapter.api.outbox()
  const detail = await adapter.api.thread('thread-3')
  const other = await adapter.api.thread('thread-2')
  if (!detail || !other) throw new Error('Expected two synthetic threads')
  adapter.api.outbox = async () => [{ ...delivery, status: 'sent', threadId: detail.thread.id }]
  const readThreads = adapter.api.threads.getMockImplementation()
  if (!readThreads) throw new Error('Expected synthetic mailbox reads')
  adapter.api.threads.mockImplementation((query) =>
    query.view.kind === 'sent' ? Promise.resolve([other.thread]) : readThreads(query),
  )
  const narrow = compactViewport()
  await mount(adapter)
  narrow()
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Outbox' })))
  const late = deferred<typeof detail>()
  adapter.api.thread.mockReturnValueOnce(late.promise)
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'View Thread' })))
  expect(screen.getByText('Loading thread')).toBeTruthy()
  await act(async () => late.resolve(detail))
  expect(reader(detail.thread.subject)).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Back to mailbox' }))
  expect(selected()).toBe(row(other.thread.subject))
  expect(options()).toHaveLength(1)
})

it('advances the compact reader after Archive and returns to Inbox when empty', async () => {
  const adapter = rendererAdapter()
  const narrow = compactViewport()
  await mount(adapter)
  narrow()
  await act(async () => fireEvent.click(row(firstSubject)))
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Archive' })))
  expect(reader(secondSubject)).toBeTruthy()
  expect(screen.getByRole('button', { name: 'Back to mailbox' })).toBeTruthy()

  adapter.api.threads.mockResolvedValue([])
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Archive' })))
  expect(screen.queryByRole('button', { name: 'Back to mailbox' })).toBeNull()
  expect(screen.getByText('Inbox is clear')).toBeTruthy()
  expect(document.activeElement).toBe(screen.getByRole('heading', { name: 'Inbox' }))
})

it('closes a notification-opened reader when Archive removes its collapsed Inbox row', async () => {
  const adapter = rendererAdapter()
  const target = (await adapter.api.thread('thread-1'))?.thread
  if (!target) throw new Error('Expected notification thread')
  let notify: ((thread: NonNullable<typeof target>) => void) | undefined
  adapter.api.onOpenThread = (callback) => {
    notify = callback
    return () => {
      notify = undefined
    }
  }
  const narrow = compactViewport()
  await mount(adapter)
  narrow()
  adapter.api.threads.mockResolvedValueOnce([target])
  await act(async () => adapter.emitChanged())
  fireEvent.click(screen.getByRole('button', { name: /^Action\/Reply/ }))
  expect(screen.queryByRole('option')).toBeNull()
  await act(async () => notify?.(target))
  expect(reader()).toBeTruthy()

  adapter.api.threads.mockResolvedValue([])
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Archive' })))
  expect(screen.queryByRole('button', { name: 'Back to mailbox' })).toBeNull()
  expect(screen.getByText('Inbox is clear')).toBeTruthy()
})

it('applies one off-reader bucket change to the existing row', async () => {
  const adapter = await mount()
  const before = mailboxNodes()
  const changed = options()[1]
  expect(within(changed).queryByText('Later')).toBeNull()
  await act(async () => {
    await adapter.api.setBucket({ threadId: 'thread-2', bucket: 'Reply', reason: 'Synthetic edit' })
  })
  expect(within(changed).getByText('Reply')).toBeTruthy()
  expect(options()).toEqual(before.rows)
  expectContinuity(before)
  expectBudget({ ...idleMailbox, rows: 1 })
  expect(commitCounts().rows).toEqual({ 'thread-2': 1 })
})

it('updates each count at its display site without committing the surrounding mailbox', async () => {
  const adapter = await mount()
  await openSidebarTriage()
  const before = mailboxNodes()
  const inbox = screen.getByRole('heading', { name: 'Inbox' }).parentElement
  const later = screen.getByRole('button', { name: 'Later' }).closest('li')
  if (!inbox || !later) throw new Error('Expected Inbox header and Later badge')
  const counts = await adapter.api.counts(null)
  adapter.api.counts.mockResolvedValueOnce({
    ...counts,
    inbox: 101,
    buckets: { ...counts.buckets, Later: 53 },
  })
  await act(async () => adapter.emitChanged())
  expect(within(inbox).getByText('101')).toBeTruthy()
  expect(within(later).getByText('53')).toBeTruthy()
  expectContinuity(before)
  expectBudget(idleMailbox)
})

async function openSidebarTriage() {
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Triage' })))
}

it('offers structured history search without filtering the inbox before submission', async () => {
  const adapter = await mount()
  const before = mailboxNodes()
  const input = screen.getByRole<HTMLInputElement>('textbox', { name: 'Search mail' })
  act(() => input.focus())
  expect(screen.getByText('Filters Inbox as you type')).toBeTruthy()

  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'People' })))
  expect(input.value).toBe('from:')
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Subject' })))
  expect(input.value).toBe('subject:')
  expect(document.activeElement).toBe(input)
  expect(screen.getByText('Enter a value after the colon.')).toBeTruthy()
  expect(screen.getByRole<HTMLButtonElement>('button', { name: /Search all mail/ }).disabled).toBe(
    true,
  )
  await act(async () => fireEvent.keyDown(input, { key: 'Enter' }))
  expect(adapter.api.search).not.toHaveBeenCalled()

  const value = 'subject:"print proof"'
  await act(async () => fireEvent.change(input, { target: { value } }))
  expect(adapter.api.filter).not.toHaveBeenCalled()
  expect(listbox()).toBe(before.list)
  expect(options()).toEqual(before.rows)
  expect(selected()).toBe(before.selection)
  expect(reader()).toBe(before.heading)

  const action = screen.getByRole('button', { name: /Search all mail/ })
  expect(within(action).getByText('All accounts')).toBeTruthy()
  const [account] = await adapter.api.accounts()
  await act(async () => fireEvent.keyDown(input, { key: '1', metaKey: true }))
  expect(within(action).getByText(account.address)).toBeTruthy()
  await act(async () => fireEvent.keyDown(input, { key: 'Enter', isComposing: true }))
  expect(adapter.api.search).not.toHaveBeenCalled()
  await act(async () => fireEvent.click(action))
  expect(adapter.api.search).toHaveBeenCalledExactlyOnceWith(value, account.id)
  expect(screen.queryByRole('button', { name: /Search all mail/ })).toBeNull()
  expect(document.activeElement).toBe(input)
})

it('opens a new agent thread through Cmd+K with the selected account and exact question', async () => {
  const adapter = await mount()
  const ask = vi.spyOn(adapter.api, 'askAgent')
  vi.spyOn(adapter.api, 'askAgentRuntime').mockResolvedValue('full-access')
  const [account] = await adapter.api.accounts()
  await act(async () => fireEvent.keyDown(listbox(), { key: '1', metaKey: true }))
  await act(async () => fireEvent.keyDown(listbox(), { key: 'k', metaKey: true }))
  const input = screen.getByPlaceholderText('Type a command, search, or ask about mail…')
  const question = 'Find emails from alice@example.test about the meeting'
  await act(async () => fireEvent.change(input, { target: { value: question } }))
  const action = screen.getByRole('option', { name: /Ask Agent in T3/ })
  expect(within(action).getByText(account.address)).toBeTruthy()
  expect(within(action).getByText('T3 · Full Access')).toBeTruthy()
  await act(async () => fireEvent.click(action))
  expect(ask).toHaveBeenCalledExactlyOnceWith(question, account.id)
  expect(adapter.api.search).not.toHaveBeenCalled()
})

it('applies an account and search link together and ignores the previous search reply', async () => {
  const fixture = rendererAdapter()
  let openSearch: Parameters<typeof fixture.api.onOpenMailSearch>[0] = () => {}
  fixture.api.onOpenMailSearch = (callback) => {
    openSearch = callback
    return () => {
      openSearch = () => {}
    }
  }
  const adapter = await mount(fixture)
  const [account] = await adapter.api.accounts()
  const [first] = await adapter.api.threads({ view: { kind: 'inbox' }, accountId: null })
  const stale = deferred<Awaited<ReturnType<typeof adapter.api.search>>>()
  adapter.api.search.mockReturnValueOnce(stale.promise).mockResolvedValueOnce([])
  const input = screen.getByRole<HTMLInputElement>('textbox', { name: 'Search mail' })
  await act(async () => fireEvent.change(input, { target: { value: 'old query' } }))
  await act(async () => fireEvent.keyDown(input, { key: 'Enter' }))

  const query = 'from:alice@example.test'
  const engineOrigin = 'https://engine.example.test'
  const arrivingAccount = `${account.id}-arriving`
  await act(async () =>
    openSearch({ kind: 'search', query, accountId: arrivingAccount, engineOrigin }),
  )
  expect(adapter.api.search).toHaveBeenLastCalledWith(query, arrivingAccount, 0, engineOrigin)
  expect(input.value).toBe(query)
  expect(screen.getByText('No matching threads')).toBeTruthy()
  await act(async () => stale.resolve([{ ...first, matchSnippet: 'stale reply' }]))
  expect(screen.getByText('No matching threads')).toBeTruthy()
  expect(screen.queryByText('stale reply')).toBeNull()
})

it('keeps selection and rows while a second result page fails and is retried', async () => {
  const adapter = await mount()
  const [first] = await adapter.api.threads({ view: { kind: 'inbox' }, accountId: null })
  const searchHit = { ...first, matchSnippet: first.snippet }
  const firstPage = Array.from({ length: 50 }, (_, index) => ({
    ...searchHit,
    id: index === 0 ? searchHit.id : `search-${index}`,
    subject: index === 0 ? searchHit.subject : `Synthetic search result ${index}`,
  }))
  const input = screen.getByRole<HTMLInputElement>('textbox', { name: 'Search mail' })
  adapter.api.search.mockResolvedValueOnce(firstPage)
  await act(async () => fireEvent.change(input, { target: { value: 'launch' } }))
  await act(async () => fireEvent.keyDown(input, { key: 'Enter' }))
  const before = mailboxNodes(searchHit.subject)
  adapter.api.search.mockRejectedValueOnce(new Error('Engine offline'))
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Load more results' })))
  expect(adapter.api.search).toHaveBeenLastCalledWith('launch', null, 50)
  expect(selected()).toBe(before.selection)
  adapter.api.search.mockResolvedValueOnce([])
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Retry search' })))
  expect(adapter.api.search).toHaveBeenLastCalledWith('launch', null, 50)
  expect(listbox()).toBe(before.list)
  expect(selected()).toBe(before.selection)
  expect(screen.queryByRole('button', { name: 'Load more results' })).toBeNull()
})

it('moves focus and selection from search to the matching threads with Arrow Down', async () => {
  await mount()
  const input = screen.getByRole('textbox', { name: 'Search mail' })
  act(() => input.focus())
  await act(async () => fireEvent.change(input, { target: { value: 'e' } }))
  const previous = selected()
  await act(async () => fireEvent.keyDown(input, { key: 'ArrowDown' }))
  expect(document.activeElement).toBe(listbox())
  expect(selected()).not.toBe(previous)
  expect(screen.queryByRole('button', { name: /Search all mail/ })).toBeNull()
})

it('commits only the indicator when an account reports a sync error', async () => {
  const adapter = await mount()
  const before = mailboxNodes()
  const accounts = await adapter.api.accounts()
  adapter.api.accounts.mockResolvedValueOnce(
    accounts.map((account) => ({ ...account, status: 'auth_expired' })),
  )
  await act(async () => adapter.emitChanged())
  expect(screen.getByText('Sign in again needed')).toBeTruthy()
  expectContinuity(before)
  expectBudget({ ...idleMailbox, indicator: 1 })
  expect(commitCounts().indicator).toBe(1)
})

it.each(['filter', 'history'] as const)(
  'refreshes one %s result without committing other rows or the reader',
  async (mode) => {
    const adapter = await mount()
    const input = screen.getByRole('textbox', { name: /Search mail/ })
    await act(async () => fireEvent.change(input, { target: { value: 'e' } }))
    if (mode === 'history') {
      await act(async () => fireEvent.keyDown(input, { key: 'Enter' }))
      expect(adapter.api.search).toHaveBeenCalledExactlyOnceWith('e', null)
      expect(adapter.api.summaries).toHaveBeenCalled()
    } else {
      expect(adapter.api.filter).toHaveBeenCalledExactlyOnceWith('e', null)
    }
    const changed = row(secondSubject)
    const before = mailboxNodes()
    commits.clear()

    await act(async () => {
      await adapter.api.setBucket({
        threadId: 'thread-2',
        bucket: 'Later',
        reason: 'Search result edit',
      })
    })
    expect(within(changed).getByText('Later')).toBeTruthy()
    expectContinuity(before)
    expectBudget({ ...idleMailbox, rows: 1 })
    expect(commitCounts().rows).toEqual({ 'thread-2': 1 })
  },
)

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
  expect(options()).toEqual(before.rows)
  expectContinuity(before)
  expectBudget(idleMailbox)

  await act(async () => stale.resolve(source))
  expect(options()).toEqual([before.rows[1], before.rows[0], ...before.rows.slice(2)])
  expectContinuity(before)
  expectBudget({ list: 1, reader: 0, rows: 1 })
  expect(commitCounts().rows).toEqual({ 'thread-2': 1 })
})

it('recovers from a same-key list failure and keeps the reader through a pending retry', async () => {
  const adapter = await mount()
  const before = mailboxNodes()
  adapter.api.threads.mockRejectedValueOnce(new Error('Synthetic list failure'))
  await act(async () => adapter.emitChanged())
  expect(screen.getByText('Could not load threads')).toBeTruthy()
  expect(reader()).toBe(before.heading)
  expectContinuity(before)
  expectBudget(idleMailbox)

  const source = await adapter.api.threads({ view: { kind: 'inbox' }, accountId: null })
  const retry = deferred<typeof source>()
  adapter.api.threads.mockReturnValueOnce(retry.promise)
  commits.clear()
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Retry' })))
  expectContinuity(before)
  await act(async () => retry.resolve(source))
  expect(screen.queryByText('Could not load threads')).toBeNull()
  expectContinuity(before)
  expectBudget(idleMailbox)
})

it('retains the selected thread and mounted Inbox through a same-pairing resnapshot', async () => {
  const adapter = await mount()
  await act(async () => fireEvent.click(row(secondSubject)))
  const before = mailboxNodes(secondSubject)
  commits.clear()
  const threadRead = adapter.api.thread.getMockImplementation()
  const listRead = adapter.api.threads.getMockImplementation()
  if (!listRead || !threadRead) throw new Error('Expected synthetic mailbox reads')
  adapter.api.threads.mockClear().mockResolvedValue([])
  adapter.api.thread.mockClear().mockResolvedValue(null)
  await act(async () => {
    adapter.emitStatus({ phase: 'bootstrapping', progress: 0 })
    adapter.emitChanged()
  })
  expect(adapter.api.threads).not.toHaveBeenCalled()
  expect(adapter.api.thread).not.toHaveBeenCalled()
  expectContinuity(before, secondSubject)
  expectBudget({ app: 0, reader: 0, rows: 0 })

  commits.clear()
  adapter.api.threads.mockImplementation(listRead)
  adapter.api.thread.mockImplementation(threadRead)
  await act(async () => {
    adapter.emitChanged()
    adapter.emitStatus({ phase: 'live', progress: null })
  })
  expect(adapter.api.threads).toHaveBeenCalledTimes(1)
  expect(adapter.api.thread.mock.calls).toEqual([['thread-2'], ['thread-7']])
  expect(options()).toHaveLength(threadCount)
  expectContinuity(before, secondSubject)
  expectBudget({ app: 0, reader: 0, rows: 0 })
})
