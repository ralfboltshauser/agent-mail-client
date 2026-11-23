import { act, fireEvent, screen } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import { deferred, rendererAdapter } from './adapter'
import { commitCounts, commits, expectBudget } from './profile'
import { listbox, mount, options, reader, row, selected } from './workspace'

const nextSubject = 'Sunday at the studio'

function archiveFixture(holdRevalidation = false) {
  const adapter = rendererAdapter()
  const { api } = adapter
  const detailGate = deferred<void>()
  const listGate = deferred<void>()
  const bodyGate = deferred<void>()
  const revalidation = deferred<void>()
  const events: string[] = []
  let archived = false
  const readDetail = api.thread.getMockImplementation()
  const readList = api.threads.getMockImplementation()
  if (!readDetail || !readList) throw new Error('Expected synthetic replica reads')
  const remoteHtml = vi.spyOn(api, 'messageHtml')
  const inlineAttachment = vi.spyOn(api, 'inlineAttachment')
  const write = api.organise
  const organise = vi.spyOn(api, 'organise')
  api.thread.mockImplementation(async (id) => {
    const detail = await readDetail(id)
    if (id !== 'thread-2' || !detail) return detail
    events.push('successor detail requested')
    await (archived && holdRevalidation ? revalidation : detailGate).promise
    return {
      ...detail,
      messages: detail.messages.map((message) => ({
        ...message,
        hasHtml: true,
        bodyText: null,
      })),
    }
  })
  api.threads.mockImplementation(async (query) => {
    const result = await readList(query)
    if (archived) {
      events.push('Inbox refresh requested')
      await listGate.promise
      events.push('Inbox refresh released')
    }
    return result
  })
  api.cachedMessageHtml = vi.fn(async (id) => {
    events.push(`HTML requested for ${id}`)
    await (archived && holdRevalidation ? revalidation : bodyGate).promise
    return '<p>Synthetic successor HTML</p><img src="https://example.invalid/pixel">'
  })
  organise.mockImplementation(async (action) => {
    events.push(`write ${action.kind}`)
    archived = true
    return write(action)
  })
  return {
    adapter,
    detailGate,
    listGate,
    bodyGate,
    revalidation,
    events,
    organise,
    remoteHtml,
    inlineAttachment,
  }
}

const archive = (target: HTMLElement) => fireEvent.keyDown(target, { key: 'e' })
const frame = () => document.querySelector<HTMLIFrameElement>('iframe[title="Message"]')
const detailLoading = () => screen.queryByText('Loading thread', { exact: true })
// This harness checks data availability. Electron checks iframe geometry and visibility.
const bodyLoading = () => document.querySelector('[aria-busy="true"]:not(:has(iframe))')

it('advances from Archive to the already prepared successor body after the list accepts the write', async () => {
  const {
    adapter,
    detailGate,
    listGate,
    bodyGate,
    revalidation,
    events,
    organise,
    remoteHtml,
    inlineAttachment,
  } = archiveFixture(true)
  await mount(adapter)
  const list = listbox()
  const heading = reader()
  const survivor = row(nextSubject)
  act(() => list.focus())

  await act(async () => detailGate.resolve())
  await act(async () => bodyGate.resolve())
  const before = [...events]
  expect(frame()).toBeNull()
  expect(reader()).toBe(heading)
  expectBudget({ workspace: 0, list: 0, reader: 0, rows: 0 })
  commits.clear()

  await act(async () => archive(list))
  expect(organise).toHaveBeenCalledExactlyOnceWith({ kind: 'archive', threadId: 'thread-1' })
  expect(reader()).toBe(heading)
  await act(async () => listGate.resolve())
  const atAdvance = {
    selection: selected().dataset.threadId,
    detailLoading: !!detailLoading(),
    bodyLoading: !!bodyLoading(),
    html: frame()?.srcdoc.includes('Synthetic successor HTML') ?? false,
  }
  if (process.env.AMC_RENDERER_COUNTS === '1') {
    console.log(JSON.stringify({ before, events, atAdvance, commits: commitCounts() }))
  }
  expect(before).toEqual(['successor detail requested', 'HTML requested for thread-2:latest'])
  expect(atAdvance).toEqual({
    selection: 'thread-2',
    detailLoading: false,
    bodyLoading: false,
    html: true,
  })
  expect(frame()?.srcdoc).toContain('img-src data: cid:;')
  expect(remoteHtml).not.toHaveBeenCalled()
  expect(inlineAttachment).not.toHaveBeenCalled()
  expect(listbox()).toBe(list)
  expect(document.activeElement).toBe(list)
  expect(selected()).toBe(survivor)
  await act(async () => revalidation.resolve())
})

it('uses normal loading for a cold advance and ignores the late body after a second Archive', async () => {
  const { adapter, detailGate, listGate, events, organise, remoteHtml } = archiveFixture()
  const visibleBody = deferred<string>()
  remoteHtml.mockReturnValue(visibleBody.promise)
  await mount(adapter)
  const list = listbox()
  const third = options()[2]
  const thirdId = third.dataset.threadId
  act(() => list.focus())

  await act(async () => archive(list))
  await act(async () => listGate.resolve())
  expect(selected().dataset.threadId).toBe('thread-2')
  expect(detailLoading()).toBeTruthy()
  expect(events.filter((event) => event === 'successor detail requested')).toHaveLength(1)

  await act(async () => detailGate.resolve())
  expect(reader(nextSubject)).toBeTruthy()
  expect(bodyLoading()).toBeTruthy()
  // The archive's invalidation superseded the first detail read. It retries once
  // after settlement, and the selected reader keeps the same subscription.
  expect(events.filter((event) => event === 'successor detail requested')).toHaveLength(2)
  expect(events.filter((event) => event.startsWith('HTML requested'))).toHaveLength(0)
  expect(remoteHtml).toHaveBeenCalledExactlyOnceWith('thread-2:latest')

  await act(async () => archive(list))
  expect(organise.mock.calls).toEqual([
    [{ kind: 'archive', threadId: 'thread-1' }],
    [{ kind: 'archive', threadId: 'thread-2' }],
  ])
  expect(selected().dataset.threadId).toBe(thirdId)
  await act(async () => visibleBody.resolve('<p>Late visible body</p>'))
  expect(selected()).toBe(third)
  expect(document.activeElement).toBe(list)
  expect(frame()).toBeNull()
  expect(detailLoading()).toBeNull()
  expect(bodyLoading()).toBeNull()
})

it('follows the latest visible section order and leaves selection alone after a failed Archive', async () => {
  const adapter = rendererAdapter()
  const { api } = adapter
  const organise = vi.spyOn(api, 'organise')
  await mount(adapter)
  const list = listbox()
  const heading = reader()
  const selectedRow = selected()
  act(() => list.focus())
  expect(api.thread.mock.calls.map(([id]) => id)).toEqual(['thread-1', 'thread-2'])

  await act(async () =>
    api.setBucket({ threadId: 'thread-2', bucket: 'Follow-up', reason: 'Synthetic reorder' }),
  )
  const successor = options()[1]
  expect(successor.dataset.threadId).toBe('thread-7')
  expect(api.thread).toHaveBeenCalledWith('thread-7')
  expect(api.thread).not.toHaveBeenCalledWith('thread-8')

  organise.mockRejectedValueOnce(new Error('Synthetic Archive failure'))
  await act(async () => archive(list))
  expect(organise).toHaveBeenCalledExactlyOnceWith({ kind: 'archive', threadId: 'thread-1' })
  expect(reader()).toBe(heading)
  expect(selected()).toBe(selectedRow)
  expect(document.activeElement).toBe(list)

  await act(async () => archive(list))
  expect(selected()).toBe(successor)
  expect(reader('Notes from the type review')).toBeTruthy()
  expect(detailLoading()).toBeNull()
  expect(bodyLoading()).toBeNull()
})

it('shows prepared text immediately while uncached HTML loads in the reader', async () => {
  const adapter = rendererAdapter()
  const { api } = adapter
  const read = api.thread.getMockImplementation()
  if (!read) throw new Error('Expected synthetic detail reads')
  api.thread.mockImplementation(async (id) => {
    const detail = await read(id)
    if (id !== 'thread-2' || !detail) return detail
    return {
      ...detail,
      messages: detail.messages.map((message) => ({
        ...message,
        hasHtml: true,
        bodyText: 'Prepared readable text',
      })),
    }
  })
  const localHtml = vi.spyOn(api, 'cachedMessageHtml').mockResolvedValue(null)
  const gate = deferred<string>()
  const visibleHtml = vi.spyOn(api, 'messageHtml').mockReturnValue(gate.promise)
  await mount(adapter)
  expect(localHtml).toHaveBeenCalledWith('thread-2:latest')
  expect(visibleHtml).not.toHaveBeenCalled()
  expect(frame()).toBeNull()

  await act(async () => archive(listbox()))
  expect(visibleHtml).toHaveBeenCalledExactlyOnceWith('thread-2:latest')
  expect(screen.getByText('Prepared readable text')).toBeTruthy()
  expect(bodyLoading()).toBeNull()
  await act(async () => gate.resolve('<p>Visible HTML fetch</p>'))
  expect(frame()?.srcdoc).toContain('Visible HTML fetch')
})

it('requests the current HTML when attachment metadata supersedes a pending reply', async () => {
  const adapter = rendererAdapter()
  const { api } = adapter
  const read = api.thread.getMockImplementation()
  if (!read) throw new Error('Expected synthetic detail reads')
  let filename = 'old.txt'
  api.thread.mockImplementation(async (id) => {
    const detail = await read(id)
    if (id !== 'thread-1' || !detail) return detail
    return {
      ...detail,
      messages: detail.messages.map((message) =>
        message.id.endsWith(':latest')
          ? {
              ...message,
              hasHtml: true,
              attachments: [
                {
                  id: 'fixture-file',
                  filename,
                  mimeType: 'text/plain',
                  size: 10,
                  inline: false,
                  contentId: null,
                },
              ],
            }
          : message,
      ),
    }
  })
  const superseded = deferred<null>()
  const html = vi
    .spyOn(api, 'messageHtml')
    .mockReturnValueOnce(superseded.promise)
    .mockResolvedValueOnce('<p>Current HTML after attachment change</p>')
  await mount(adapter)
  expect(html).toHaveBeenCalledExactlyOnceWith('thread-1:latest')
  filename = 'current.txt'
  await act(async () => adapter.emitChanged())
  expect(html).toHaveBeenCalledTimes(2)
  await act(async () => superseded.resolve(null))
  expect(frame()?.srcdoc).toContain('Current HTML after attachment change')
})

it('adopts the in-flight local body and drops its superseded reply after a replica change', async () => {
  const { adapter, detailGate, listGate, remoteHtml } = archiveFixture()
  const old = deferred<string>()
  const current = deferred<string>()
  const localHtml = vi
    .spyOn(adapter.api, 'cachedMessageHtml')
    .mockReturnValueOnce(old.promise)
    .mockReturnValueOnce(current.promise)
  await mount(adapter)
  await act(async () => detailGate.resolve())
  expect(localHtml).toHaveBeenCalledExactlyOnceWith('thread-2:latest')
  await act(async () => archive(listbox()))
  await act(async () => listGate.resolve())
  expect(reader(nextSubject)).toBeTruthy()
  expect(detailLoading()).toBeNull()
  expect(bodyLoading()).toBeTruthy()
  expect(localHtml).toHaveBeenCalledTimes(1)
  expect(remoteHtml).not.toHaveBeenCalled()

  await act(async () => old.resolve('<p>Superseded body</p>'))
  expect(localHtml).toHaveBeenCalledTimes(2)
  expect(frame()).toBeNull()
  await act(async () => current.resolve('<p>Accepted local body</p>'))
  expect(frame()?.srcdoc).toContain('Accepted local body')
  expect(remoteHtml).not.toHaveBeenCalled()
})

it('reuses a prepared deferred text body without opening any other message', async () => {
  const adapter = rendererAdapter()
  const { api } = adapter
  const read = api.thread.getMockImplementation()
  if (!read) throw new Error('Expected synthetic detail reads')
  api.thread.mockImplementation(async (id) => {
    const detail = await read(id)
    if (!detail || id !== 'thread-2') return detail
    return {
      ...detail,
      messages: detail.messages.map((message) => ({
        ...message,
        bodyText: null,
        bodyRevision: '',
      })),
    }
  })
  const localText = vi.spyOn(api, 'messageText').mockResolvedValue('Prepared synthetic text')
  await mount(adapter)
  expect(localText).toHaveBeenCalledExactlyOnceWith('thread-2:latest')
  expect(screen.queryByText('Prepared synthetic text')).toBeNull()
  expect(api.thread.mock.calls.map(([id]) => id)).toEqual(['thread-1', 'thread-2'])

  await act(async () => archive(listbox()))
  expect(reader(nextSubject)).toBeTruthy()
  expect(screen.getByText('Prepared synthetic text')).toBeTruthy()
  expect(detailLoading()).toBeNull()
  expect(bodyLoading()).toBeNull()
})

it('rejects a successor detail from another Account and retries against the accepted Inbox', async () => {
  const adapter = rendererAdapter()
  const { api } = adapter
  const read = api.thread.getMockImplementation()
  if (!read) throw new Error('Expected synthetic detail reads')
  let firstSuccessorRead = true
  api.thread.mockImplementation(async (id) => {
    const detail = await read(id)
    if (id !== 'thread-2' || !detail || !firstSuccessorRead) return detail
    firstSuccessorRead = false
    return {
      ...detail,
      thread: { ...detail.thread, accountId: 'other-account' },
      messages: detail.messages.map((message) => ({ ...message, hasHtml: true, bodyText: null })),
    }
  })
  const localHtml = vi.spyOn(api, 'cachedMessageHtml')
  await mount(adapter)
  expect(reader()).toBeTruthy()
  expect(localHtml).not.toHaveBeenCalled()

  await act(async () => archive(listbox()))
  expect(selected().dataset.threadId).toBe('thread-2')
  expect(reader(nextSubject)).toBeTruthy()
  expect(screen.queryByText('Could not load this thread')).toBeNull()
  expect(localHtml).not.toHaveBeenCalled()
})
