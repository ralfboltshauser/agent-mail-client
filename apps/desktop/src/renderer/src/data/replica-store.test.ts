import { createHash } from 'node:crypto'
import type { ThreadSummary } from '@amc/protocol'
import { expect, it, vi } from 'vitest'
import type { SyncStatus, ThreadQuery } from '../../../shared/api'
import type { QuerySnapshot } from './query-cache'
import { ReplicaStore } from './replica-store'
import { selectedSnapshot } from './selection'
import { messageTextQuery, threadListQuery } from './thread-queries'

const live: SyncStatus = {
  phase: 'live',
  engineUrl: 'https://engine.example',
  progress: null,
  lastSyncAt: null,
  error: null,
}
const inbox: ThreadQuery = { view: { kind: 'inbox' }, accountId: 'account' }
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((success, failure) => {
    resolve = success
    reject = failure
  })
  return { promise, resolve, reject }
}
const settle = () => new Promise<void>((resolve) => setImmediate(resolve))
const ignore = () => {}

function fixture(readStatus = async () => live) {
  const statusListeners = new Set<(next: SyncStatus) => void>()
  const changedListeners = new Set<() => void>()
  const status = vi.fn(readStatus)
  const store = new ReplicaStore({
    status,
    onStatus: (listener) => {
      statusListeners.add(listener)
      return () => statusListeners.delete(listener)
    },
    onChanged: (listener) => {
      changedListeners.add(listener)
      return () => changedListeners.delete(listener)
    },
  })
  return {
    store,
    status,
    statusListeners,
    changedListeners,
    pushStatus: (next: SyncStatus) => {
      for (const listener of statusListeners) listener(next)
    },
    changed: () => {
      for (const listener of changedListeners) listener()
    },
  }
}

function row(id: string): ThreadSummary {
  return {
    id,
    accountId: 'account',
    subject: id,
    snippet: '',
    participants: [],
    labelIds: [],
    messageCount: 1,
    unreadCount: 1,
    starred: false,
    inInbox: true,
    hasAttachments: false,
    lastMessageAt: 1,
    snoozedUntil: null,
    muted: false,
  }
}

it('keeps selected snapshots stable across equal replies, row edits and reordering', async () => {
  const { store, changed } = fixture()
  let rows = [row('a'), row('b')]
  const api = { threads: vi.fn(async () => structuredClone(rows)) }
  const query = threadListQuery(api, inbox)
  const read = () => store.getQuery(query)
  const ids = selectedSnapshot(read, ({ data }) => data?.ids)
  const first = selectedSnapshot(read, ({ data }) => data?.summaries.get('a'))
  const second = selectedSnapshot(read, ({ data }) => data?.summaries.get('b'))
  const initial = read()
  expect(read()).toBe(initial)
  const stop = store.subscribeQuery(query, ignore)
  const stopDuplicate = store.subscribeQuery(threadListQuery(api, structuredClone(inbox)), ignore)
  await settle()
  expect(api.threads).toHaveBeenCalledExactlyOnceWith(inbox)
  const originalIndex = read().data
  const order = ids()
  const a = first()
  const b = second()
  expect(order).toEqual(['a', 'b'])

  changed()
  const pending = read()
  expect(read()).toBe(pending)
  expect(pending.state).toBe('cached+refreshing')
  expect(pending.data).toBe(originalIndex)
  await settle()
  expect(read().data).toBe(originalIndex)
  expect(ids()).toBe(order)

  rows = [{ ...row('a'), bucket: null }, row('b')]
  changed()
  await settle()
  expect(ids()).toBe(order)
  expect(first()).not.toBe(a)
  expect(second()).toBe(b)

  const updatedA = first()
  const summaries = read().data?.summaries
  rows.reverse()
  changed()
  await settle()
  expect(ids()).toEqual(['b', 'a'])
  expect(read().data?.summaries).toBe(summaries)
  expect(first()).toBe(updatedA)
  expect(second()).toBe(b)
  stopDuplicate()
  stop()
})

it('retains same-key data on refresh and failure and accepts an authoritative empty result', async () => {
  const { store } = fixture()
  const error = new Error('read failed')
  const load = vi.fn<() => Promise<string[]>>()
  load
    .mockRejectedValueOnce(error)
    .mockResolvedValueOnce(['a'])
    .mockRejectedValueOnce(error)
    .mockResolvedValueOnce([])
  const query = { key: 'inbox', load }
  const stop = store.subscribeQuery(query, ignore)
  await settle()
  expect(store.getQuery(query)).toEqual({ state: 'first-error', error })
  await store.refresh(query)
  const data = store.getQuery(query).data
  const retry = store.refresh(query)
  expect(store.getQuery(query)).toEqual({ state: 'cached+refreshing', data: ['a'] })
  await retry
  expect(store.getQuery(query)).toEqual({ state: 'cached+error', data: ['a'], error })
  expect(store.getQuery(query).data).toBe(data)
  await store.refresh(query)
  expect(store.getQuery(query)).toEqual({ state: 'empty-success', data: [] })
  stop()
})

it.each(['reply', 'error'])(
  'deduplicates reads and coalesces a stale %s into one newer read',
  async (outcome) => {
    const { store, changed } = fixture()
    const first = deferred<string[]>()
    const second = deferred<string[]>()
    const load = vi
      .fn<() => Promise<string[]>>()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise)
    const query = { key: 'inbox', load }
    const seen: QuerySnapshot<string[]>[] = []
    const stop = store.subscribeQuery(query, () => seen.push(store.getQuery(query)))
    const stopDuplicate = store.subscribeQuery(query, ignore)
    await settle()
    const pending = store.refresh(query)
    expect(pending).toBeDefined()
    expect(store.refresh(query)).toBe(pending)
    changed()
    changed()
    expect(load).toHaveBeenCalledTimes(1)
    if (outcome === 'reply') first.resolve(['superseded'])
    else first.reject(new Error('superseded'))
    await pending
    expect(store.getQuery(query).state).toBe('first-load')
    expect(load).toHaveBeenCalledTimes(2)
    second.resolve(['current'])
    await store.refresh(query)
    expect(seen).toEqual([{ state: 'cached', data: ['current'] }])
    stopDuplicate()
    stop()
  },
)

it('clears cached data on unpair and discards old replies even when pairing to the same URL', async () => {
  const { store, pushStatus, changed } = fixture()
  const old = deferred<string[]>()
  const load = vi
    .fn<() => Promise<string[]>>()
    .mockResolvedValueOnce(['old cache'])
    .mockReturnValueOnce(old.promise)
    .mockResolvedValueOnce(['new pairing'])
  const query = { key: 'inbox', load }
  const stop = store.subscribeQuery(query, ignore)
  await settle()
  changed()
  await settle()
  const oldRead = store.refresh(query)
  pushStatus({ ...live, phase: 'unpaired' })
  expect(store.getQuery(query).state).toBe('first-load')
  pushStatus(live)
  await settle()
  old.resolve(['old pairing'])
  await oldRead
  expect(store.getQuery(query)).toEqual({ state: 'cached', data: ['new pairing'] })
  stop()
})

it('detaches IPC listeners and ignores pending status and data from a stopped session', async () => {
  const initial = deferred<SyncStatus>()
  const oldLoad = deferred<number>()
  const { store, status, changedListeners, statusListeners, pushStatus, changed } = fixture(
    () => initial.promise,
  )
  const query = { key: 'inbox', load: vi.fn(() => oldLoad.promise) }
  const stopStatus = store.subscribeStatus(ignore)
  const stopQuery = store.subscribeQuery(query, ignore)
  const stopSecond = store.subscribeQuery({ ...query, key: 'other account' }, ignore)
  expect(statusListeners.size).toBe(1)
  expect(changedListeners.size).toBe(1)
  expect(status).toHaveBeenCalledOnce()
  pushStatus(live)
  await settle()
  stopSecond()
  stopQuery()
  expect(changedListeners.size).toBe(0)
  expect(statusListeners.size).toBe(1)
  changed()
  stopStatus()
  expect(statusListeners.size).toBe(0)
  oldLoad.resolve(1)
  initial.resolve({ ...live, phase: 'unpaired' })
  await settle()
  expect(store.getStatus().value).toBeNull()
  expect(store.getQuery(query).state).toBe('first-load')
  expect(query.load).toHaveBeenCalledTimes(2)
})

it('holds populated lists through a resnapshot and fences other account keys', async () => {
  const { store, changed, pushStatus } = fixture()
  let rows = [row('a')]
  const api = { threads: vi.fn(async () => structuredClone(rows)) }
  const query = threadListQuery(api, inbox)
  const other = threadListQuery(api, { ...inbox, accountId: 'other' })
  const stop = store.subscribeQuery(query, ignore)
  await settle()
  const cached = store.getQuery(query).data
  pushStatus({ ...live, phase: 'bootstrapping' })
  rows = []
  const stopOther = store.subscribeQuery(other, ignore)
  changed()
  await settle()
  expect(store.getQuery(other).state).toBe('first-load')
  expect(store.getQuery(query)).toEqual({ state: 'cached+refreshing', data: cached })
  expect(store.getQuery(query).data).toBe(cached)
  pushStatus({ ...live, phase: 'offline' })
  changed()
  await settle()
  expect(store.getQuery(query).data).toBe(cached)
  pushStatus(live)
  await settle()
  expect(store.getQuery(other).state).toBe('empty-success')
  expect(store.getQuery(query).data?.ids).toEqual([])
  stopOther()
  stop()
})

it('uses status events ahead of the initial read and preserves equal field selections', async () => {
  const initial = deferred<SyncStatus>()
  const { store, pushStatus } = fixture(() => initial.promise)
  const stop = store.subscribeStatus(ignore)
  const status = { ...live, healthWarnings: ['warning'] }
  pushStatus(status)
  const first = store.getStatus()
  const warnings = selectedSnapshot(store.getStatus, ({ value }) => value?.healthWarnings)
  const firstWarnings = warnings()
  initial.resolve({ ...live, phase: 'unpaired' })
  await settle()
  expect(store.getStatus()).toBe(first)
  pushStatus(structuredClone(status))
  expect(store.getStatus()).toBe(first)
  pushStatus({ ...structuredClone(status), lastSyncAt: 10 })
  expect(store.getStatus().value?.lastSyncAt).toBe(10)
  expect(warnings()).toBe(firstWarnings)
  stop()
})

it('reuses verified text by revision and rejects text from a different revision', async () => {
  const { store, changed } = fixture()
  const stopStatus = store.subscribeStatus(ignore)
  const api = { messageText: vi.fn(async () => 'current text') }
  const revision = createHash('sha256').update('current text').digest('hex')
  const query = messageTextQuery(api, 'message', revision)
  const stop = store.subscribeQuery(query, ignore)
  await Promise.resolve()
  const pending = store.refresh(query)
  expect(pending).toBeDefined()
  await pending
  expect(store.getQuery(query)).toEqual({ state: 'cached', data: 'current text' })
  stop()
  const stopAgain = store.subscribeQuery(query, ignore)
  changed()
  expect(api.messageText).toHaveBeenCalledOnce()

  const old = messageTextQuery(
    api,
    'message',
    createHash('sha256').update('old text').digest('hex'),
  )
  const stopOld = store.subscribeQuery(old, ignore)
  await store.refresh(old)
  expect(store.getQuery(old).state).toBe('first-error')
  stopOld()
  stopAgain()
  stopStatus()
})
