import { describe, expect, it } from 'vitest'
import { fromGmail } from './mapping.ts'
import type { GmailMessage } from './types.ts'

const b64 = (s: string, enc: BufferEncoding = 'utf8') => Buffer.from(s, enc).toString('base64url')

describe('fromGmail', () => {
  it('maps headers, bodies, labels and attachments', () => {
    const message: GmailMessage = {
      id: 'm1',
      threadId: 't1',
      labelIds: ['INBOX', 'UNREAD'],
      snippet: 'Hi &amp; welcome',
      internalDate: '1700000000000',
      sizeEstimate: 4242,
      payload: {
        mimeType: 'multipart/mixed',
        headers: [
          { name: 'From', value: '"Doe, Jane" <jane@x.com>' },
          { name: 'To', value: 'a@b.com, "Bob" <bob@c.com>' },
          { name: 'Subject', value: ' Plans ' },
          { name: 'Message-ID', value: '<abc@x.com>' },
          { name: 'In-Reply-To', value: '<prev@x.com>' },
          { name: 'List-Unsubscribe', value: '<mailto:u@x.com>' },
        ],
        parts: [
          {
            mimeType: 'multipart/alternative',
            parts: [
              { mimeType: 'text/plain', body: { size: 5, data: b64('Hello\r\n\r\n\r\nthere') } },
              { mimeType: 'text/html', body: { size: 5, data: b64('<p>Hello</p>') } },
            ],
          },
          {
            mimeType: 'application/pdf',
            filename: 'plan.pdf',
            headers: [{ name: 'Content-Disposition', value: 'attachment; filename="plan.pdf"' }],
            body: { size: 1000, attachmentId: 'att1' },
          },
          {
            mimeType: 'image/png',
            filename: 'logo.png',
            headers: [
              { name: 'Content-Disposition', value: 'inline' },
              { name: 'Content-ID', value: '<logo>' },
            ],
            body: { size: 3, data: b64('png') },
          },
        ],
      },
    }
    const m = fromGmail(message)
    expect(m.from).toEqual({ name: 'Doe, Jane', address: 'jane@x.com' })
    expect(m.to).toEqual([
      { name: null, address: 'a@b.com' },
      { name: 'Bob', address: 'bob@c.com' },
    ])
    expect(m.subject).toBe('Plans')
    expect(m.rfcMessageId).toBe('abc@x.com')
    expect(m.inReplyTo).toBe('prev@x.com')
    expect(m.snippet).toBe('Hi & welcome')
    expect(m.bodyText).toBe('Hello\n\nthere')
    expect(m.bodyHtml).toBe('<p>Hello</p>')
    expect(m.sentAt).toBe(1700000000000)
    expect(m.deliveredAt).toBe(1700000000000)
    expect(m.attachments).toHaveLength(2)
    expect(m.attachments[0]).toMatchObject({
      filename: 'plan.pdf',
      providerAttachmentId: 'att1',
      inline: false,
    })
    expect(m.attachments[1]).toMatchObject({
      filename: 'logo.png',
      inline: true,
      contentId: 'logo',
    })
    expect(m.listUnsubscribe).toBe('<mailto:u@x.com>')
  })

  it('derives text from HTML-only mail and decodes legacy charsets', () => {
    const m = fromGmail({
      id: 'm2',
      threadId: 't2',
      payload: {
        mimeType: 'text/html',
        headers: [{ name: 'Content-Type', value: 'text/html; charset=iso-8859-1' }],
        body: {
          size: 10,
          data: b64('<style>x{}</style><p>Grüezi</p><p>Welt &amp; mehr</p>', 'latin1'),
        },
      },
    })
    expect(m.bodyText).toBe('Grüezi\nWelt & mehr')
  })
})
