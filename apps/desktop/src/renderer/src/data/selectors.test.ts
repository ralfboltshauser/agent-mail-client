// @vitest-environment jsdom

import { ThreadSummary } from '@amc/protocol'
import { act, createElement, StrictMode, useLayoutEffect } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import type { SyncStatus, ThreadQuery } from '../../../shared/api'
import { usePairingGate, useSyncField, useThreadIds, useThreadSummary } from '../hooks/use-amc'

it('isolates timestamp and row commits while preserving focused DOM through failure and retry', async () => {
  const query: ThreadQuery = { view: { kind: 'inbox' }, accountId: null }
  const status: SyncStatus = {
    phase: 'live',
    engineUrl: 'https://engine.example',
    progress: null,
    lastSyncAt: 1,
    error: null,
  }
  const makeRow = (id: string) =>
    ThreadSummary.parse({
      id,
      accountId: 'test',
      subject: id,
      snippet: '',
      participants: [],
      messageCount: 1,
      unreadCount: 1,
      starred: false,
      inInbox: true,
      hasAttachments: false,
      labelIds: [],
      lastMessageAt: 1,
    })
  let rows = [makeRow('a'), makeRow('b')]
  let failing = false
  const statusListeners = new Set<(status: SyncStatus) => void>()
  const changedListeners = new Set<() => void>()
  const threads = vi.fn(async () => {
    if (failing) throw new Error('Replica unavailable')
    return structuredClone(rows)
  })
  vi.stubGlobal('amc', {
    status: async () => status,
    onStatus: (listener: (status: SyncStatus) => void) => {
      statusListeners.add(listener)
      return () => statusListeners.delete(listener)
    },
    onChanged: (listener: () => void) => {
      changedListeners.add(listener)
      return () => changedListeners.delete(listener)
    },
    threads,
  })
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)

  const commits: string[] = []
  function useCommit(region: string) {
    useLayoutEffect(() => {
      commits.push(region)
    })
  }

  function Row({ id }: { id: string }) {
    const summary = useThreadSummary(query, id)
    useCommit(id)
    return createElement('li', null, createElement('button', { type: 'button' }, summary?.subject))
  }

  function List() {
    const ids = useThreadIds(query)
    useCommit('list')
    return createElement(
      'ul',
      null,
      ids?.map((id) => createElement(Row, { id, key: id })),
    )
  }

  function SyncIndicator() {
    const { timestamp } = useSyncField(
      (current) => ({ timestamp: current?.lastSyncAt }),
      (left, right) => left.timestamp === right.timestamp,
    )
    useCommit('sync')
    return createElement('output', null, timestamp)
  }

  function Shell() {
    const gate = usePairingGate()
    useCommit('shell')
    return gate.phase === 'paired'
      ? createElement('main', null, createElement(SyncIndicator), createElement(List))
      : null
  }

  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  const publishChange = () =>
    act(async () => {
      for (const listener of changedListeners) listener()
    })
  try {
    await act(async () => {
      root.render(createElement(StrictMode, null, createElement(Shell)))
    })
    expect(threads).toHaveBeenCalledOnce()
    const list = container.querySelector('ul')
    const [first, second] = container.querySelectorAll('button')
    expect(first?.textContent).toBe('a')
    expect(second?.textContent).toBe('b')
    first?.focus()
    commits.length = 0

    await act(async () => {
      for (const listener of statusListeners) listener({ ...status, lastSyncAt: 2 })
    })
    expect(commits).toEqual(['sync'])
    expect(container.querySelector('output')?.textContent).toBe('2')
    commits.length = 0

    await publishChange()
    expect(commits).toEqual([])
    rows = [{ ...makeRow('a'), subject: 'Edited' }, makeRow('b')]
    await publishChange()
    expect(commits).toEqual(['a'])
    expect(first?.textContent).toBe('Edited')
    commits.length = 0

    failing = true
    await publishChange()
    failing = false
    await publishChange()
    expect(commits).toEqual([])
    expect(container.querySelector('ul')).toBe(list)
    const [currentFirst, currentSecond] = container.querySelectorAll('button')
    expect(currentFirst).toBe(first)
    expect(currentSecond).toBe(second)
    expect(document.activeElement).toBe(first)
  } finally {
    await act(async () => root.unmount())
    container.remove()
    vi.unstubAllGlobals()
  }
  expect(statusListeners.size).toBe(0)
  expect(changedListeners.size).toBe(0)
})
