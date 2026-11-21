// @vitest-environment jsdom

import { MessageDetail, ThreadSummary } from '@amc/protocol'
import { act, createElement, createRef } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { Replica } from '../../../main/replica'
import { ThreadView } from './thread-view'

it('reveals old headers and loads one complete body from the replica on expansion', async () => {
  const replica = new Replica(':memory:')
  const root = createRoot(document.body)
  const longBody = 'Long message text. '.repeat(20_000)
  const messageText = vi.fn(async (id: string) => replica.messageText(id))
  vi.stubGlobal('amc', { messageText })
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)

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
    await act(async () =>
      root.render(
        createElement(ThreadView, {
          data,
          labelNames: new Map(),
          snoozeEnabled: false,
          scrollRef: createRef<HTMLDivElement>(),
        }),
      ),
    )
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
  } finally {
    await act(async () => root.unmount())
    vi.unstubAllGlobals()
    replica.db.close()
  }
})
