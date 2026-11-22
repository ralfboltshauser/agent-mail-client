import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { StrictMode } from 'react'
import { expect, it, vi } from 'vitest'
import { App } from '@/app'
import type { AmcApi } from '../../apps/desktop/src/shared/api'
import { rendererAdapter } from './adapter'
import { commitCounts, commits, expectBudget } from './profile'
import { listbox, options, reader, selected } from './workspace'

type ThreadSummary = Awaited<ReturnType<AmcApi['threads']>>[number]

const inbox = { view: { kind: 'inbox' as const }, accountId: null }
const headers = ['New senders', 'Action/Reply', 'Follow-up', 'Updates', 'Seen']
const header = (name: string) => screen.getByRole('button', { name: new RegExp(`^${name} \\d+`) })
const sectionCommits = () =>
  Object.fromEntries([...commits].filter(([id]) => id.startsWith('section:')))
const rowIds = () => options().map((node) => node.dataset.threadId)
const byId = (id: string) => options().find((node) => node.dataset.threadId === id)

async function mountSections(project?: (rows: ThreadSummary[]) => ThreadSummary[]) {
  const adapter = rendererAdapter()
  const read = adapter.api.threads.getMockImplementation()
  if (!read) throw new Error('Expected synthetic thread reads')
  if (project) {
    adapter.api.threads.mockImplementation(async (query) => {
      const rows = project(await read(query))
      return query.limit === -1 ? rows : rows.slice(0, query.limit ?? 5000)
    })
  }
  let notify: (row: ThreadSummary) => void = () => {}
  adapter.api.onOpenThread = (callback) => {
    notify = callback
    return () => {}
  }
  vi.stubGlobal('amc', adapter.api)
  const app = (
    <StrictMode>
      <App />
    </StrictMode>
  )
  const result = await act(async () => render(app))
  commits.clear()
  return { ...adapter, result, app, notify: (row: ThreadSummary) => notify(row) }
}

it('starts with three Updates and preserves collapse across account switches and restart', async () => {
  const { api, result, app } = await mountSections()
  expect(api.threads).toHaveBeenCalledWith(inbox)
  expect(screen.getAllByRole('heading', { level: 3 }).map((node) => node.textContent)).toEqual([
    'New senders0',
    'Action/Reply4',
    'Follow-up1',
    'Updates3',
    'Seen0',
  ])
  // The legacy fixture has exactly three Updates. Move a fourth Thread in.
  await act(async () => api.setBucket({ threadId: 'thread-8', bucket: 'Later', reason: 'Update' }))
  expect(header('Updates').textContent).toBe('Updates4')
  expect(rowIds()).not.toContain('thread-8')
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Show all' })))
  expect(rowIds()).toContain('thread-8')

  const survivor = byId('thread-3')
  await act(async () => fireEvent.click(header('Updates')))
  expect(byId('thread-3')).toBe(survivor)
  expect(header('Updates').getAttribute('aria-expanded')).toBe('false')
  expect(rowIds()).not.toContain('thread-4')

  await act(async () => fireEvent.keyDown(document.body, { key: '1', metaKey: true }))
  expect(header('Updates').getAttribute('aria-expanded')).toBe('true')
  await act(async () => fireEvent.keyDown(document.body, { key: '0', metaKey: true }))
  expect(header('Updates').getAttribute('aria-expanded')).toBe('false')

  result.unmount()
  await act(async () => render(app))
  expect(header('Updates').getAttribute('aria-expanded')).toBe('false')
})

it('groups new Senders by Account and opens all represented Threads', async () => {
  const { notify, api } = await mountSections((threads) =>
    threads.map((thread, index) =>
      index === 0 || index === 3
        ? {
            ...thread,
            inboxSender: {
              accountId: thread.accountId,
              address: 'sender@example.test',
              status: 'new',
              messageId: `sender-message-${index}`,
              revision: 0,
            },
          }
        : index === 4
          ? { ...thread, ownerHandledMessageId: null }
          : thread,
    ),
  )
  expect(header('New senders').textContent).toBe('New senders1')
  expect(header('Seen').textContent).toBe('Seen1')
  const card = byId('thread-1')
  expect(card).toBeTruthy()
  if (!card) throw new Error('Expected the representative Thread')
  expect(within(card).getByText('2 Threads')).toBeTruthy()
  expect(within(card).getAllByText('sender@example.test').length).toBeGreaterThan(0)
  expect(byId('thread-4')).toBeUndefined()
  await act(async () => fireEvent.click(card))
  expect(rowIds()).toEqual(['thread-1', 'thread-4'])
  expect(document.activeElement).toBe(listbox())

  const target = (await api.threads({ ...inbox, limit: -1 })).find(({ id }) => id === 'thread-4')
  if (!target) throw new Error('Expected notification target')
  await act(async () => notify(target))
  expect(selected().dataset.threadId).toBe('thread-4')
  expect(screen.queryByRole('button', { name: 'Back to Inbox' })).toBeNull()
})

it('navigates across section boundaries and activates disclosure with native keyboard focus', async () => {
  await mountSections()
  const active = listbox()
  act(() => active.focus())
  expect(selected().dataset.threadId).toBe('thread-1')
  await act(async () => fireEvent.keyDown(active, { key: 'J', shiftKey: true }))
  expect(document.activeElement).toBe(header('Follow-up'))
  expect(fireEvent.keyDown(header('Follow-up'), { key: ' ' })).toBe(true)
  await act(async () => fireEvent.click(header('Follow-up')))
  expect(header('Follow-up').getAttribute('aria-expanded')).toBe('false')
  await act(async () => fireEvent.keyDown(header('Follow-up'), { key: 'J', shiftKey: true }))
  expect(document.activeElement).toBe(header('Updates'))
  await act(async () => fireEvent.keyDown(header('Updates'), { key: 'k' }))
  expect(document.activeElement).toBe(active)
  expect(selected().dataset.threadId).toBe('thread-8')
  await act(async () => fireEvent.keyDown(active, { key: 'j' }))
  expect(selected().dataset.threadId).toBe('thread-4')
  expect(headers.map(header)).toHaveLength(5)
})

it('keeps row DOM identity and commits only the moved row and affected section headings', async () => {
  const adapter = await mountSections()
  const list = listbox()
  act(() => list.focus())
  const before = options()
  const current = selected()
  const heading = reader()
  commits.clear()

  await act(async () =>
    adapter.api.setBucket({
      threadId: 'thread-2',
      bucket: 'Follow-up',
      reason: 'Synthetic cross-section move',
    }),
  )
  expect(rowIds().slice(0, 4)).toEqual(['thread-1', 'thread-7', 'thread-8', 'thread-2'])
  expect(listbox()).toBe(list)
  expect(document.activeElement).toBe(list)
  expect(selected()).toBe(current)
  expect(reader()).toBe(heading)
  for (const node of before) expect(options()).toContain(node)
  expectBudget({ app: 0, workspace: 0, list: 1, rows: 1, reader: 0, composer: 0 })
  expect(commitCounts().rows).toEqual({ 'thread-2': 1 })
  expect(sectionCommits()).toEqual({ 'section:Action/Reply': 1, 'section:Follow-up': 1 })

  commits.clear()
  const release = adapter.staggerReads()
  await act(async () => adapter.emitChanged())
  for (const resolve of release()) await act(async () => resolve())
  expectBudget({ app: 0, workspace: 0, list: 0, rows: 0, reader: 0, composer: 0 })
  expect(sectionCommits()).toEqual({})
})

it('keeps the viewport anchored to a surviving Thread after collapsing an earlier section', async () => {
  await mountSections()
  const viewport = listbox().closest<HTMLElement>('[data-thread-viewport]')
  const anchor = byId('thread-4')
  if (!viewport || !anchor) throw new Error('Expected the virtual viewport and its anchor')
  const start = () => Number(anchor.style.transform.match(/translateY\(([-.\d]+)px\)/)?.[1])
  Object.defineProperties(viewport, {
    scrollHeight: { configurable: true, value: 1200 },
    scrollTo: {
      configurable: true,
      value: ({ top }: ScrollToOptions) => {
        viewport.scrollTop = top ?? 0
      },
    },
  })
  const distance = 12
  await act(async () => {
    viewport.scrollTop = start() + distance
    fireEvent.scroll(viewport)
  })
  const formerOffset = viewport.scrollTop
  await act(async () => fireEvent.click(header('Follow-up')))
  expect(byId('thread-4')).toBe(anchor)
  expect(viewport.scrollTop).toBe(start() + distance)
  expect(viewport.scrollTop).toBeLessThan(formerOffset)
})

it('indexes Threads beyond the legacy replica cap while mounting a bounded window', async () => {
  const { api } = await mountSections(([first]) =>
    Array.from({ length: 5105 }, (_, index) => ({
      ...first,
      id: index === 0 ? first.id : `synthetic-${index}`,
      lastMessageAt: first.lastMessageAt - index,
      bucket: index === 5104 ? null : first.bucket,
      unreadCount: index === 5104 ? 0 : 1,
      ownerHandledMessageId: null,
    })),
  )
  expect(api.threads).toHaveBeenLastCalledWith({ ...inbox, limit: -1 })
  expect(header('Action/Reply').textContent).toBe('Action/Reply5104')
  expect(header('Seen').textContent).toBe('Seen1')
  expect(options().length).toBeLessThan(40)
  const list = listbox()
  await act(async () => fireEvent.click(header('Action/Reply')))
  expect(selected().dataset.threadId).toBe('synthetic-5104')
  expect(listbox()).toBe(list)
})
