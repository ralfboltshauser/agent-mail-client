// @vitest-environment jsdom

import { MessageDetail, ThreadSummary } from '@amc/protocol'
import { act, createElement, createRef, StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { Replica } from '../../../main/replica'
import type { ReplicaThreadMessage, ThreadWithMessages } from '../../../shared/api'
import { createFixture } from '../dev/mail-fixture'
import { ThreadView } from './thread-view'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

it('loads and refreshes a complete deferred body while its message stays expanded', async () => {
  const replica = new Replica(':memory:')
  const root = createRoot(document.body)
  const longBody = 'Long message text. '.repeat(20_000)
  const messageText = vi.fn(async (id: string) => replica.messageText(id))
  vi.stubGlobal('amc', { ...createFixture('inbox'), messageText })
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)

  const scrollRef = createRef<HTMLDivElement>()
  const render = async () => {
    await act(async () =>
      root.render(
        createElement(ThreadView, {
          data: replica.thread('thread'),
          labelNames: new Map(),
          snoozeEnabled: false,
          scrollRef,
        }),
      ),
    )
  }

  try {
    const thread = ThreadSummary.parse({
      id: 'thread',
      accountId: 'a',
      subject: 'Subject',
      snippet: '',
      participants: [],
      messageCount: 6,
      unreadCount: 1,
      labelIds: [],
      starred: false,
      inInbox: true,
      hasAttachments: false,
      lastMessageAt: 6,
    })
    replica.put('thread', thread)
    for (let n = 1; n <= 6; n++) {
      const message = MessageDetail.parse({
        id: String(n),
        threadId: thread.id,
        accountId: 'a',
        rfcMessageId: null,
        inReplyTo: null,
        from: { name: `Sender ${n}`, address: 'sender@example.com' },
        to: [],
        cc: [],
        bcc: [],
        replyTo: [],
        subject: 'Subject',
        snippet: `Preview ${n}`,
        bodyText: n === 1 ? `${longBody}End 1` : `Body ${n}`,
        hasHtml: false,
        sentAt: n,
        unread: n === 3,
        starred: false,
        labelIds: [],
        listUnsubscribe: null,
        attachments: [],
      })
      if (n === 1) {
        // Pre-upgrade rows stored the body in the message JSON.
        replica.db
          .prepare('INSERT INTO message (id, thread_id, sent_at, data) VALUES (?, ?, ?, ?)')
          .run(message.id, message.threadId, message.sentAt, JSON.stringify(message))
      } else {
        replica.put('message', message)
      }
    }

    const data = replica.thread(thread.id)
    expect(data?.messages.map((message) => message.bodyText)).toEqual([
      null,
      null,
      'Body 3',
      'Body 4',
      'Body 5',
      'Body 6',
    ])
    await render()
    expect(document.body.textContent).toContain('Body 3')
    expect(document.body.textContent).toContain('Body 6')
    expect(document.body.textContent).not.toContain('Preview 1')

    const older = [...document.querySelectorAll('button')].find(
      (button) => button.textContent === '2 older messages',
    )
    expect(older?.getAttribute('aria-expanded')).toBe('false')
    await act(async () => older?.click())
    expect(older?.getAttribute('aria-expanded')).toBe('true')
    expect(messageText).not.toHaveBeenCalled()
    expect(document.body.textContent).toContain('Preview 1')

    const firstMessage = [...document.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('Sender 1'),
    )
    await act(async () => firstMessage?.click())
    expect(messageText.mock.calls).toEqual([['1']])
    expect(document.body.textContent).toContain(`${longBody}End 1`)

    const original = data?.messages[0]
    const messageBody = () =>
      document
        .getElementById(firstMessage?.getAttribute('aria-controls') ?? '')
        ?.querySelector('.whitespace-pre-wrap')
    const body = messageBody()
    const scroll = scrollRef.current
    if (!original || !body || !scroll) throw new Error('Expected the loaded message and reader')
    scroll.scrollTop = 300

    const stale = deferred<string>()
    const newest = deferred<string>()
    messageText.mockReturnValueOnce(stale.promise).mockReturnValueOnce(newest.promise)
    replica.put('message', MessageDetail.parse({ ...original, bodyText: 'Stale revision' }))
    await render()
    expect(body.textContent).toContain('End 1')
    expect(document.querySelector('[aria-busy=true]')).toBeNull()

    replica.put('message', MessageDetail.parse({ ...original, bodyText: `${longBody}Updated 1` }))
    await render()
    expect(body.textContent).toContain('End 1')
    expect(messageText.mock.calls).toEqual([['1'], ['1'], ['1']])

    await act(async () => newest.resolve(`${longBody}Updated 1`))
    await act(async () => stale.resolve('Stale revision'))
    await vi.waitFor(() => expect(body.textContent?.endsWith('Updated 1')).toBe(true))

    // Unread promotion pulls a message out of the older group and makes text eager.
    replica.put(
      'message',
      MessageDetail.parse({ ...original, unread: true, bodyText: `${longBody}Updated 1` }),
    )
    await render()
    expect(older?.isConnected).toBe(false)
    expect(document.body.textContent).toContain('1 older message')
    expect(document.body.textContent).toContain('Preview 2')
    expect(firstMessage?.getAttribute('aria-expanded')).toBe('true')
    expect(messageBody()).toBe(body)

    // Marking it read defers its text again. The accepted revision is already present.
    replica.put('message', MessageDetail.parse({ ...original, bodyText: `${longBody}Updated 1` }))
    await render()
    expect(firstMessage?.getAttribute('aria-expanded')).toBe('true')
    expect(messageBody()).toBe(body)
    expect(messageText).toHaveBeenCalledTimes(3)
    expect(scrollRef.current).toBe(scroll)
    expect(scroll.scrollTop).toBe(300)

    messageText.mockRejectedValueOnce(new Error('Body read failed'))
    replica.put('message', MessageDetail.parse({ ...original, bodyText: 'Recovered body' }))
    await render()
    expect(document.body.textContent?.includes('Updated 1')).toBe(false)
    const retry = [...document.querySelectorAll('button')].find(
      (button) => button.textContent === 'Could not load message. Retry',
    )
    expect(retry).toBeDefined()
    await act(async () => retry?.click())
    await vi.waitFor(() => expect(document.body.textContent).toContain('Recovered body'))
  } finally {
    await act(async () => root.unmount())
    vi.unstubAllGlobals()
    replica.db.close()
  }
})

it('deduplicates slow inline bodies and retains iframe height and consent across refresh', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const observers: {
    measure: () => void
    disconnect: ReturnType<typeof vi.fn>
  }[] = []
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe = vi.fn()
      disconnect = vi.fn()
      constructor(measure: () => void) {
        observers.push({ measure, disconnect: this.disconnect })
      }
    },
  )
  const firstInline = deferred<string>()
  const nextInline = deferred<string>()
  const remote = '<img src="https://example.com/remote.png">'
  const messageHtml = vi
    .fn(async () => `<p>Updated body</p><img src="cid:image">${remote}`)
    .mockResolvedValueOnce(`<p>First body</p><img src="cid:image">${remote}`)
  const inlineAttachment = vi
    .fn()
    .mockReturnValueOnce(firstInline.promise)
    .mockReturnValueOnce(nextInline.promise)
  const openExternal = vi.fn()
  vi.stubGlobal('amc', { ...createFixture('inbox'), messageHtml, inlineAttachment, openExternal })

  const root = createRoot(document.body)
  const scrollRef = createRef<HTMLDivElement>()
  const thread = ThreadSummary.parse({
    id: 'thread',
    accountId: 'a',
    subject: 'Subject',
    snippet: '',
    participants: [],
    messageCount: 1,
    unreadCount: 1,
    labelIds: [],
    starred: false,
    inInbox: true,
    hasAttachments: true,
    lastMessageAt: 1,
  })
  const message: ReplicaThreadMessage = {
    ...MessageDetail.parse({
      id: 'message',
      threadId: thread.id,
      accountId: 'a',
      rfcMessageId: null,
      inReplyTo: null,
      from: { name: 'Sender', address: 'sender@example.com' },
      to: [],
      cc: [],
      bcc: [],
      replyTo: [],
      subject: 'Subject',
      snippet: 'Preview',
      bodyText: 'Text fallback',
      hasHtml: true,
      sentAt: 1,
      unread: true,
      starred: false,
      labelIds: [],
      listUnsubscribe: null,
      attachments: [
        {
          id: 'image-part',
          filename: 'image.png',
          inline: true,
          contentId: 'image',
          mimeType: 'image/png',
          size: 120,
        },
      ],
    }),
    bodyRevision: '1',
  }
  const render = (next: ReplicaThreadMessage, nextThread = thread) => {
    const data: ThreadWithMessages = {
      thread: nextThread,
      messages: [structuredClone(next)],
      drafts: [],
    }
    return act(async () =>
      root.render(
        createElement(
          StrictMode,
          null,
          createElement(ThreadView, {
            data,
            labelNames: new Map(),
            snoozeEnabled: false,
            scrollRef,
          }),
        ),
      ),
    )
  }

  try {
    await render(message)
    const pending = document.querySelector<HTMLElement>('[aria-busy=true]')
    expect(pending?.style.minHeight).toBe('120px')
    await render(message)
    expect(document.querySelector('[aria-busy=true]')).toBe(pending)
    expect(messageHtml).toHaveBeenCalledTimes(1)
    expect(inlineAttachment.mock.calls).toEqual([['image-part']])

    await act(async () => firstInline.resolve('first-image-data'))
    const frame = document.querySelector('iframe')
    if (!frame?.contentDocument) throw new Error('Expected message iframe')
    expect(frame.getAttribute('sandbox')).toBe('allow-same-origin')
    expect(frame.srcdoc).toContain('data:image/png;base64,first-image-data')
    expect(frame.srcdoc).toContain('img-src data: cid:;')
    expect(frame.style.height).toBe('120px')
    Object.defineProperties(frame, {
      clientWidth: { value: 600 },
      offsetHeight: { get: () => Number.parseInt(frame.style.height, 10) },
    })

    const load = async (height: number) => {
      const frameDocument = frame.contentDocument
      if (!frameDocument?.body) throw new Error('Expected iframe body')
      // jsdom exposes the srcdoc attribute without navigating or laying out the document.
      const parsed = new DOMParser().parseFromString(frame.srcdoc, 'text/html')
      if (!parsed.firstChild) throw new Error('Expected srcdoc contents')
      if (frameDocument.firstChild?.nodeType === Node.COMMENT_NODE) {
        frameDocument.firstChild.remove()
      }
      frameDocument.prepend(frameDocument.importNode(parsed.firstChild, true))
      Object.defineProperties(frameDocument, {
        URL: { configurable: true, value: 'about:srcdoc' },
        readyState: { configurable: true, value: 'complete' },
      })
      const body = frameDocument.body
      Object.defineProperty(body, 'scrollHeight', { configurable: true, value: height })
      await act(async () => frame.dispatchEvent(new Event('load')))
      return observers.at(-1)
    }
    const first = await load(240)
    expect(frame.style.height).toBe('242px')
    expect(frame.style.visibility).toBe('visible')
    await act(async () => frame.dispatchEvent(new Event('load')))
    expect(observers).toEqual([first])
    expect(first?.disconnect).not.toHaveBeenCalled()

    const oldDocument = frame.contentDocument
    const oldLink = oldDocument.createElement('a')
    oldLink.href = 'https://example.com/'
    oldDocument.body.append(oldLink)
    await act(async () => oldLink.click())
    expect(openExternal).toHaveBeenCalledTimes(1)

    const allowImages = [...document.querySelectorAll('button')].find(
      (button) => button.textContent === 'Load images',
    )
    await act(async () => allowImages?.click())
    expect(first?.disconnect).toHaveBeenCalledTimes(1)
    expect(frame.srcdoc).toContain('img-src data: cid: https: http:;')
    expect(frame.style.height).toBe('242px')
    await act(async () => frame.dispatchEvent(new Event('load')))
    expect(frame.style.visibility).toBe('hidden')
    // A retained document or queued observer from the previous navigation is inert.
    expect(oldLink.dispatchEvent(new Event('click', { bubbles: true, cancelable: true }))).toBe(
      true,
    )
    expect(openExternal).toHaveBeenCalledTimes(1)
    await act(async () => first?.measure())
    expect(frame.style.height).toBe('242px')
    const consented = await load(240)

    const sameVersion = frame.srcdoc
    await render(message)
    expect(document.querySelector('iframe')).toBe(frame)
    expect(frame.srcdoc).toBe(sameVersion)
    expect(consented?.disconnect).not.toHaveBeenCalled()

    const updated = { ...message, bodyRevision: '2' }
    await render(updated)
    await render(updated)
    expect(messageHtml).toHaveBeenCalledTimes(2)
    expect(inlineAttachment).toHaveBeenCalledTimes(2)
    expect(frame.srcdoc).toBe(sameVersion)
    expect(frame.style.height).toBe('242px')

    await act(async () => nextInline.resolve('updated-image-data'))
    expect(document.querySelector('iframe')).toBe(frame)
    expect(frame.srcdoc).toContain('Updated body')
    expect(frame.srcdoc).toContain('data:image/png;base64,updated-image-data')
    expect(frame.srcdoc).toContain('img-src data: cid: https: http:;')
    expect(consented?.disconnect).toHaveBeenCalledTimes(1)
    expect(frame.style.height).toBe('242px')
    await load(80)
    expect(frame.style.height).toBe('120px')

    const lateHtml = deferred<string>()
    const otherHtml = deferred<string>()
    messageHtml.mockReturnValueOnce(lateHtml.promise).mockReturnValueOnce(otherHtml.promise)
    await render({ ...message, bodyRevision: '3' })
    const nextThread = { ...thread, id: 'another-thread', subject: 'Another thread' }
    await render({ ...message, id: 'another-message', threadId: nextThread.id }, nextThread)
    expect(document.body.textContent).toContain(nextThread.subject)
    expect(document.querySelector('iframe')).toBeNull()
    await act(async () => otherHtml.resolve('<p>Another thread body</p>'))
    await act(async () => lateHtml.resolve('<p>Late previous thread body</p>'))
    const nextFrame = document.querySelector('iframe')
    expect(nextFrame).not.toBe(frame)
    expect(nextFrame?.srcdoc).toContain('Another thread body')
    expect(nextFrame?.srcdoc).not.toContain('Late previous thread body')
  } finally {
    await act(async () => root.unmount())
    vi.unstubAllGlobals()
  }

  expect(observers.length).toBeGreaterThan(0)
  for (const observer of observers) expect(observer.disconnect).toHaveBeenCalledTimes(1)
})
