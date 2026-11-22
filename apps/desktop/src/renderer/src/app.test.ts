// @vitest-environment jsdom

import { type OutboxItem, type SearchHit, ThreadSummary } from '@amc/protocol'
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { toast } from 'sonner'
import { expect, it, vi } from 'vitest'
import { App, showQueuedSend } from './app'

it.each(['resolves', 'rejects'] as const)(
  'keeps the notification thread selected when an earlier search %s',
  async (outcome) => {
    const target = ThreadSummary.parse({
      id: 'notification',
      accountId: 'a',
      subject: 'From notification',
      snippet: '',
      participants: [],
      messageCount: 1,
      unreadCount: 1,
      labelIds: [],
      starred: false,
      inInbox: true,
      hasAttachments: false,
      lastMessageAt: 1,
    })
    const hit: SearchHit = { ...target, id: 'search-hit', subject: 'From search', matchSnippet: '' }
    let finishSearch: (() => void) | undefined
    const search = vi.fn(
      () =>
        new Promise<SearchHit[]>((resolve, reject) => {
          finishSearch = () => {
            if (outcome === 'resolves') resolve([hit])
            else reject(new Error('Search failed'))
          }
        }),
    )
    let openThread: ((thread: ThreadSummary) => void) | undefined
    const thread = vi.fn(async () => null)
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
    vi.stubGlobal('amc', {
      status: async () => ({ phase: 'live' }),
      onStatus: () => () => {},
      onChanged: () => () => {},
      onTriageStatus: () => () => {},
      triageCounts: async () => ({ recent: 0, older: 0 }),
      triageStatus: async () => ({ enabled: true, running: false, lastRun: null, notice: null }),
      onOpenThread: (callback: typeof openThread) => {
        openThread = callback
        return () => {}
      },
      accounts: async () => [],
      labels: async () => [],
      counts: async () => ({ inbox: 0, inboxUnread: 0, starred: 0, drafts: 0, buckets: {} }),
      threads: async () => [],
      filter: async () => null,
      thread,
      search,
      summaries: async () => [],
      activeHandoff: async () => null,
      organiseErrors: async () => [],
    })

    const root = createRoot(document.body)
    try {
      await act(async () => root.render(createElement(App)))
      const input = document.querySelector<HTMLInputElement>('input[placeholder^="Filter"]')
      if (!input) throw new Error('Search input is missing')
      const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
      await act(async () => {
        setValue?.call(input, 'query')
        input.dispatchEvent(new Event('input', { bubbles: true }))
      })
      await act(async () => {
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
      })
      expect(search).toHaveBeenCalledWith('query', null)
      expect(openThread).toBeTypeOf('function')
      await act(async () => openThread?.(target))
      expect(thread).toHaveBeenLastCalledWith(target.id)
      expect(input.value).toBe('')

      expect(finishSearch).toBeTypeOf('function')
      await act(async () => finishSearch?.())
      expect(input.value).toBe('')
      expect(thread).toHaveBeenLastCalledWith(target.id)
    } finally {
      await act(async () => root.unmount())
      vi.unstubAllGlobals()
    }
  },
)

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
