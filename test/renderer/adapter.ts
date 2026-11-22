import { vi } from 'vitest'
import { createMailFixture } from '@/dev/mail-fixture'
import type { AmcApi } from '../../apps/desktop/src/shared/api'

export function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((finish) => {
    resolve = finish
  })
  return { promise, resolve }
}

export function rendererAdapter() {
  const fixture = createMailFixture('inbox')
  const settingsListeners = new Set<() => void>()
  let pause: (() => Promise<void>) | undefined

  function read<Args extends unknown[], Reply>(method: (...args: Args) => Promise<Reply>) {
    return vi.fn(async (...args: Args) => {
      const wait = pause?.()
      const value = structuredClone(await method(...args))
      await wait
      return value
    })
  }

  const api = {
    ...fixture.api,
    accounts: read(fixture.api.accounts),
    labels: read(fixture.api.labels),
    counts: read(fixture.api.counts),
    threads: read(fixture.api.threads),
    filter: read(fixture.api.filter),
    search: read(fixture.api.search),
    summaries: read(fixture.api.summaries),
    thread: read(fixture.api.thread),
    activeHandoff: read(fixture.api.activeHandoff),
    triageCounts: read(fixture.api.triageCounts),
    organiseErrors: read(fixture.api.organiseErrors),
    composeDraft: read(fixture.api.composeDraft),
    saveCompose: read(fixture.api.saveCompose),
    startCompose: read(fixture.api.startCompose),
    status: read(fixture.api.status),
    stageComposeBody: vi.fn(fixture.api.stageComposeBody),
    onOpenSettings: (listener) => {
      settingsListeners.add(listener)
      return () => settingsListeners.delete(listener)
    },
    onStatus: (listener) => fixture.api.onStatus((status) => listener(structuredClone(status))),
  } satisfies AmcApi

  return {
    api,
    emitOpenSettings() {
      for (const listener of settingsListeners) listener()
    },
    emitChanged: fixture.emitChanged,
    emitStatus: fixture.emitStatus,
    staggerReads() {
      const replies: (() => void)[] = []
      pause = () => {
        const gate = deferred<void>()
        replies.push(() => gate.resolve())
        return gate.promise
      }
      return () => {
        pause = undefined
        return replies
      }
    },
  }
}
