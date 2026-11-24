import { vi } from 'vitest'
import { createMailFixture } from '@/dev/mail-fixture'
import type { AmcApi, MailLinkDraft } from '../../apps/desktop/src/shared/api'

export function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((finish) => {
    resolve = finish
  })
  return { promise, resolve }
}

export function rendererAdapter(scenario = 'renderer-navigation') {
  const fixture = createMailFixture(scenario)
  const diagnosticsListeners = new Set<() => void>()
  const feedbackListeners = new Set<() => void>()
  const settingsListeners = new Set<() => void>()
  const draftLinkListeners = new Set<(target: MailLinkDraft) => void>()
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
    copyDiagnostics: vi.fn(fixture.api.copyDiagnostics),
    onCopyDiagnostics: (listener) => {
      diagnosticsListeners.add(listener)
      return () => diagnosticsListeners.delete(listener)
    },
    feedback: {
      ...fixture.api.feedback,
      onOpen(listener: () => void) {
        feedbackListeners.add(listener)
        return () => feedbackListeners.delete(listener)
      },
      capture: vi.fn(async (_view: string) => ({ id: 'renderer-fixture' })),
      send: vi.fn(fixture.api.feedback.send),
      copy: vi.fn(fixture.api.feedback.copy),
    },
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
    composeDraft: read((id: string, engineOrigin?: string) =>
      fixture.api.composeDraft(id, engineOrigin),
    ),
    composeDraftByMessage: read(fixture.api.composeDraftByMessage),
    saveCompose: read(fixture.api.saveCompose),
    startCompose: read(fixture.api.startCompose),
    status: read(fixture.api.status),
    stageComposeBody: vi.fn(fixture.api.stageComposeBody),
    onOpenSettings: (listener) => {
      settingsListeners.add(listener)
      return () => settingsListeners.delete(listener)
    },
    onOpenMailDraft: (listener) => {
      draftLinkListeners.add(listener)
      return () => draftLinkListeners.delete(listener)
    },
    onStatus: (listener) => fixture.api.onStatus((status) => listener(structuredClone(status))),
  } satisfies AmcApi

  return {
    api,
    emitCopyDiagnostics() {
      for (const listener of diagnosticsListeners) listener()
    },
    emitFeedback() {
      for (const listener of feedbackListeners) listener()
    },
    emitOpenSettings() {
      for (const listener of settingsListeners) listener()
    },
    emitDraftLink(target: MailLinkDraft) {
      for (const listener of draftLinkListeners) listener(target)
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
