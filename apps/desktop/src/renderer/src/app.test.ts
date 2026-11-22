// @vitest-environment jsdom

import { type OutboxItem, type SearchHit, ThreadSummary } from '@amc/protocol'
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { toast } from 'sonner'
import { expect, it, onTestFinished, vi } from 'vitest'
import type { AmcApi, SyncStatus, ThreadWithMessages } from '../../shared/api'
import { App } from './app'
import { showQueuedSend } from './features/mailbox/send-undo'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((done, fail) => {
    resolve = done
    reject = fail
  })
  return { promise, resolve, reject }
}

function summary(id: string, accountId = 'a') {
  return ThreadSummary.parse({
    id,
    accountId,
    subject: id,
    snippet: '',
    participants: [],
    messageCount: 0,
    unreadCount: 0,
    labelIds: [],
    starred: false,
    inInbox: true,
    hasAttachments: false,
    lastMessageAt: 1,
  })
}

function detail(thread: ThreadSummary): ThreadWithMessages {
  return { thread, messages: [], drafts: [] }
}

const live: SyncStatus = {
  phase: 'live',
  engineUrl: 'https://engine.example',
  progress: null,
  lastSyncAt: null,
  error: null,
}

async function openMailbox(api: Partial<AmcApi>) {
  const changed = new Set<() => void>()
  let status: ((status: SyncStatus) => void) | undefined
  let openThread: ((thread: ThreadSummary) => void) | undefined
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('matchMedia', () => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  }))
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  )
  vi.spyOn(Element.prototype, 'clientWidth', 'get').mockReturnValue(400)
  vi.spyOn(Element.prototype, 'clientHeight', 'get').mockReturnValue(600)
  const amc: Partial<AmcApi> = {
    status: async () => live,
    onStatus: (callback) => {
      status = callback
      return () => {
        status = undefined
      }
    },
    onChanged: (callback) => {
      changed.add(callback)
      return () => {
        changed.delete(callback)
      }
    },
    onTriageStatus: () => () => {},
    triageCounts: async () => ({ recent: 0, older: 0 }),
    triageStatus: async () => ({ enabled: true, running: false, lastRun: null, notice: null }),
    onOpenThread: (callback) => {
      openThread = callback
      return () => {
        openThread = undefined
      }
    },
    accounts: async () =>
      ['a', 'b'].map((id) => ({
        id,
        kind: 'gmail',
        address: `${id}@example.test`,
        displayName: null,
        status: 'ready',
        lastSyncAt: null,
        lastError: null,
        messageCount: 1,
        backfill: { phase: 'done', fetched: 1, estimatedTotal: 1 },
      })),
    labels: async () => [],
    counts: async () => ({ inbox: 0, inboxUnread: 0, starred: 0, drafts: 0, buckets: {} }),
    threads: async () => [],
    filter: async () => [],
    thread: async () => null,
    summaries: async () => [],
    activeHandoff: async () => null,
    organiseErrors: async () => [],
    ...api,
  }
  vi.stubGlobal('amc', amc)
  const root = createRoot(document.body)
  onTestFinished(async () => {
    await act(async () => root.unmount())
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })
  await act(async () => root.render(createElement(App)))
  return {
    changed: () =>
      act(async () => {
        for (const notify of changed) notify()
      }),
    status: (next: SyncStatus) => act(async () => status?.(next)),
    openThread: (target: ThreadSummary) => act(async () => openThread?.(target)),
  }
}

function press(key: string, target: EventTarget = document.body, options?: KeyboardEventInit) {
  return act(async () => {
    target.dispatchEvent(
      new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...options }),
    )
  })
}

function searchInput() {
  const input = document.querySelector<HTMLInputElement>('input[placeholder="Filter mail"]')
  if (!input) throw new Error('Search input is missing')
  return input
}

function typeFilter(value: string) {
  return act(async () => {
    const input = searchInput()
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

function listbox() {
  return document.querySelector<HTMLElement>('[role="listbox"][aria-label="Threads"]')
}
function selectedRow() {
  return listbox()?.querySelector('[role="option"][aria-selected="true"]')
}
function reader() {
  return document.querySelector('h1.select-text')
}
function retry(description: string) {
  const alert = [...document.querySelectorAll('[role="alert"]')].find(
    (element) => element.textContent === description,
  )
  const button = alert?.parentElement?.querySelector('button')
  if (!button) throw new Error(`Missing retry for "${description}"`)
  return act(async () => button.click())
}

it.each(['resolves', 'rejects'] as const)(
  'keeps the notification thread selected when an earlier search %s',
  async (outcome) => {
    const target = summary('From notification')
    const request = deferred<SearchHit[]>()
    const search = vi.fn(() => request.promise)
    const thread = vi.fn(async () => detail(target))
    const mailbox = await openMailbox({ thread, search })

    await typeFilter('query')
    await press('Enter', searchInput())
    expect(search).toHaveBeenCalledWith('query', null)
    await mailbox.openThread(target)
    expect(thread).toHaveBeenLastCalledWith(target.id)
    expect(reader()?.textContent).toBe(target.subject)
    expect(selectedRow()?.textContent).toContain(target.subject)

    await act(async () => {
      if (outcome === 'resolves') request.resolve([{ ...summary('From search'), matchSnippet: '' }])
      else request.reject(new Error('Search failed'))
    })
    expect(searchInput().value).toBe('')
    expect(reader()?.textContent).toBe(target.subject)
    expect(thread).toHaveBeenLastCalledWith(target.id)
  },
)

it('retains the mounted list, selected row, reader, and focus through refresh failure and retry', async () => {
  const first = summary('First')
  const second = summary('Second')
  const listFailure = deferred<ThreadSummary[]>()
  const detailFailure = deferred<ThreadWithMessages>()
  const listRetry = deferred<ThreadSummary[]>()
  const detailRetry = deferred<ThreadWithMessages>()
  const threads = vi.fn<AmcApi['threads']>().mockResolvedValue([first, second])
  const thread = vi
    .fn<AmcApi['thread']>()
    .mockImplementation(async (id) => detail(id === first.id ? first : second))
  const mailbox = await openMailbox({ threads, thread })
  const list = listbox()
  expect(list).not.toBeNull()
  list?.focus()
  if (!list) throw new Error('Missing listbox')
  await press('ArrowDown', list)
  const row = selectedRow()
  const heading = reader()
  const scroll = heading?.closest('.overflow-y-auto')
  expect(row?.textContent).toContain(second.subject)
  expect(heading?.textContent).toBe(second.subject)
  expect(scroll).not.toBeNull()
  const expectContinuity = () => {
    expect(listbox()).toBe(list)
    expect(selectedRow()).toBe(row)
    expect(reader()).toBe(heading)
    expect(reader()?.closest('.overflow-y-auto')).toBe(scroll)
    expect(document.activeElement).toBe(list)
  }

  threads.mockReturnValueOnce(listFailure.promise)
  thread.mockReturnValueOnce(detailFailure.promise)
  await mailbox.changed()
  expectContinuity()
  await act(async () => {
    listFailure.reject(new Error('Unable to read rows'))
    detailFailure.reject(new Error('Unable to read detail'))
  })
  expectContinuity()
  expect(document.body.textContent).toContain('Could not load threads')
  expect(document.body.textContent).toContain('Could not refresh this thread')

  threads.mockReturnValueOnce(listRetry.promise)
  thread.mockReturnValueOnce(detailRetry.promise)
  await retry('Could not load threads')
  await retry('Could not refresh this thread')
  expectContinuity()
  await act(async () => {
    listRetry.resolve([structuredClone(first), structuredClone(second)])
    detailRetry.resolve(detail(structuredClone(second)))
  })
  expectContinuity()
  expect(document.body.textContent).not.toContain('Could not load threads')
  expect(document.body.textContent).not.toContain('Could not refresh this thread')

  // A successful empty response is authoritative.
  threads.mockResolvedValueOnce([])
  await mailbox.changed()
  expect(listbox()).toBeNull()
  expect(reader()).toBeNull()
  expect(document.body.textContent).toContain('Inbox is clear')
})

it('fences delayed rows and reader replies across account, view, and filter keys', async () => {
  const old = summary('Old mailbox')
  const staleView = summary('Stale Inbox', 'b')
  const unread = summary('Current Unread', 'b')
  const visible = summary('Current filter', 'b')
  const oldDetail = deferred<ThreadWithMessages>()
  const inboxB = deferred<ThreadSummary[]>()
  const unreadB = deferred<ThreadSummary[]>()
  const filterA = deferred<ThreadSummary[]>()
  const filterB = deferred<ThreadSummary[]>()
  const threads = vi.fn<AmcApi['threads']>(({ accountId, view }) => {
    if (!accountId) return Promise.resolve([old])
    return view.kind === 'inbox' ? inboxB.promise : unreadB.promise
  })
  const thread = vi.fn<AmcApi['thread']>((id) => {
    if (id === old.id) return oldDetail.promise
    return Promise.resolve(detail(id === unread.id ? unread : visible))
  })
  const filter = vi.fn<AmcApi['filter']>((text) =>
    text === 'previous' ? filterA.promise : filterB.promise,
  )
  await openMailbox({ threads, thread, filter })
  expect(selectedRow()?.textContent).toContain(old.subject)

  await press('2', document.body, { metaKey: true })
  expect(threads).toHaveBeenLastCalledWith({ accountId: 'b', view: { kind: 'inbox' } })
  expect(listbox()).toBeNull()
  expect(document.body.textContent).toContain('Loading mail')
  await press('g')
  await press('u')
  expect(threads).toHaveBeenLastCalledWith({ accountId: 'b', view: { kind: 'unread' } })
  await act(async () => unreadB.resolve([unread]))
  expect(reader()?.textContent).toBe(unread.subject)
  await act(async () => {
    inboxB.resolve([staleView])
    oldDetail.resolve(detail(old))
  })
  expect(reader()?.textContent).toBe(unread.subject)
  expect(document.body.textContent).not.toContain(staleView.subject)
  expect(thread).not.toHaveBeenCalledWith(staleView.id)

  await typeFilter('previous')
  expect(listbox()).toBeNull()
  expect(reader()).toBeNull()
  await typeFilter('current')
  expect(filter).toHaveBeenLastCalledWith('current', 'b')
  await act(async () => filterB.resolve([visible]))
  await act(async () => filterA.resolve([staleView]))
  expect(selectedRow()?.textContent).toContain(visible.subject)
  expect(reader()?.textContent).toBe(visible.subject)
  expect(thread).not.toHaveBeenCalledWith(staleView.id)
})

it('keeps cached Inbox content until an in-progress snapshot can be read authoritatively', async () => {
  const cached = summary('Cached Inbox')
  const firstReply = deferred<ThreadSummary[]>()
  const finalReply = deferred<ThreadSummary[]>()
  const threads = vi
    .fn<AmcApi['threads']>()
    .mockResolvedValueOnce([cached])
    .mockReturnValueOnce(firstReply.promise)
    .mockReturnValueOnce(finalReply.promise)
  const mailbox = await openMailbox({ threads, thread: async () => detail(cached) })
  const row = selectedRow()
  const heading = reader()
  expect(row?.textContent).toContain(cached.subject)
  expect(heading?.textContent).toBe(cached.subject)
  await mailbox.changed()
  await mailbox.status({ ...live, phase: 'bootstrapping', progress: 0 })
  await act(async () => firstReply.resolve([]))
  await mailbox.changed()
  expect(threads).toHaveBeenCalledTimes(2)
  expect(selectedRow()).toBe(row)
  expect(reader()).toBe(heading)
  await mailbox.status({ ...live, phase: 'offline', progress: 0.5 })
  expect(selectedRow()).toBe(row)
  await mailbox.status(live)
  expect(threads).toHaveBeenCalledTimes(3)
  expect(selectedRow()).toBe(row)
  await act(async () => finalReply.resolve([]))
  expect(document.body.textContent).toContain('Inbox is clear')
  expect(reader()).toBeNull()
})

it('clears cached rows and reader when the Engine identity changes', async () => {
  const cached = summary('Previous Engine')
  const oldRefresh = deferred<ThreadSummary[]>()
  const nextEngine = deferred<ThreadSummary[]>()
  const threads = vi
    .fn<AmcApi['threads']>()
    .mockResolvedValueOnce([cached])
    .mockReturnValueOnce(oldRefresh.promise)
    .mockReturnValueOnce(nextEngine.promise)
  const mailbox = await openMailbox({ threads, thread: async () => detail(cached) })
  expect(reader()?.textContent).toBe(cached.subject)
  await mailbox.changed()
  await mailbox.status({ ...live, engineUrl: 'https://other-engine.example' })
  await act(async () => oldRefresh.resolve([cached]))
  expect(listbox()).toBeNull()
  expect(reader()).toBeNull()
  expect(document.body.textContent).toContain('Loading mail')
  await act(async () => nextEngine.resolve([]))
  expect(document.body.textContent).toContain('Inbox is clear')
})

it('retains same-search hits through retries and ignores the superseded search reply', async () => {
  const hit = { ...summary('History hit'), matchSnippet: 'match' }
  const stale = deferred<SearchHit[]>()
  const failure = deferred<SearchHit[]>()
  const latest = deferred<SearchHit[]>()
  const search = vi
    .fn<AmcApi['search']>()
    .mockResolvedValueOnce([hit])
    .mockReturnValueOnce(stale.promise)
    .mockReturnValueOnce(failure.promise)
    .mockReturnValueOnce(latest.promise)
  await openMailbox({ search, thread: async () => detail(hit) })
  await typeFilter('history')
  await press('Enter', searchInput())
  const row = selectedRow()
  const heading = reader()
  expect(row?.textContent).toContain(hit.subject)
  expect(heading?.textContent).toBe(hit.subject)

  await press('Enter', searchInput())
  await press('Enter', searchInput())
  await act(async () => failure.reject(new Error('History offline')))
  expect(document.body.textContent).toContain('Could not search all mail')
  expect(selectedRow()).toBe(row)
  expect(reader()).toBe(heading)
  await retry('Could not search all mail')
  await act(async () => stale.resolve([]))
  expect(selectedRow()).toBe(row)
  expect(reader()).toBe(heading)
  await act(async () => latest.resolve([]))
  expect(document.body.textContent).toContain('No matching threads')
  expect(listbox()).toBeNull()
  expect(reader()).toBeNull()
})

it.each([
  { requestElapsed: 300, engineElapsed: undefined },
  { requestElapsed: 12_300, engineElapsed: 12_000 },
])(
  'expires send Undo after accounting for transit and Engine work ($requestElapsed ms)',
  ({ requestElapsed, engineElapsed }) => {
    vi.useFakeTimers({ toFake: ['Date', 'performance', 'setTimeout', 'clearTimeout'] })
    toast.dismiss()
    const cancelSend = vi.fn()
    vi.stubGlobal('amc', { cancelSend })
    const onCancelled = vi.fn()
    const item: OutboxItem = {
      id: 'send',
      draftId: 'draft',
      accountId: 'account',
      messageId: 'message',
      subject: 'Test fixture',
      to: [],
      status: 'queued',
      sendAt: 10_000,
      undoUntil: 10_000,
      undoRemainingMs: 10_000,
      undoResponseElapsedMs: engineElapsed,
      detail: null,
      canResolve: false,
      threadId: null,
    }

    try {
      // With no Toaster mounted, Sonner's own dismissal timer never starts.
      showQueuedSend(item, requestElapsed, onCancelled)
      const [notice] = toast.getToasts()
      const action = notice && 'action' in notice ? notice.action : undefined
      if (!action || typeof action !== 'object' || !('onClick' in action)) {
        throw new Error('Missing Undo action')
      }
      expect(action.label).toBe('Undo')
      vi.advanceTimersByTime(9698)
      expect(toast.getToasts()).toEqual([notice])
      vi.advanceTimersByTime(1)
      expect(toast.getToasts()[0]).toHaveProperty('action', undefined)
      action.onClick({} as Parameters<typeof action.onClick>[0])
      expect(cancelSend).not.toHaveBeenCalled()
      expect(onCancelled).not.toHaveBeenCalled()

      toast.dismiss()
      showQueuedSend(item, 10_001 + (engineElapsed ?? 0), onCancelled)
      expect(toast.getToasts()[0]).not.toHaveProperty('action')
    } finally {
      toast.dismiss()
      vi.useRealTimers()
      vi.unstubAllGlobals()
    }
  },
)
