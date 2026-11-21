import { describe, expect, it } from 'vitest'
import { BlobStore } from '../blobs.ts'
import { tempDir, testDb } from '../test-support.ts'
import { MailQueries, toFtsQuery } from './queries.ts'
import { type IncomingMessage, MailStore } from './store.ts'

function msg(id: string, overrides: Partial<IncomingMessage> = {}): IncomingMessage {
  return {
    providerId: id,
    providerThreadId: `t-${id}`,
    rfcMessageId: null,
    inReplyTo: null,
    references: null,
    from: { name: 'Alice', address: 'alice@example.com' },
    to: [{ name: null, address: 'owner@example.com' }],
    cc: [],
    bcc: [],
    replyTo: [],
    subject: `Subject ${id}`,
    snippet: '',
    bodyText: '',
    bodyHtml: null,
    sentAt: 1000,
    size: 0,
    labels: ['INBOX'],
    listUnsubscribe: null,
    attachments: [],
    ...overrides,
  }
}

function setup() {
  const db = testDb()
  db.prepare(
    "INSERT INTO account (id, kind, address, credentials, created_at) VALUES ('a', 'gmail', 'owner@example.com', x'00', 0)",
  ).run()
  const store = new MailStore(db, new BlobStore(tempDir()))
  return { db, store, queries: new MailQueries(db) }
}

describe('MailQueries', () => {
  it('pages Threads newest first', () => {
    const { store, queries } = setup()
    for (let i = 1; i <= 5; i++)
      store.putMessage('a', ['owner@example.com'], msg(`m${i}`, { sentAt: i * 1000 }))
    const first = queries.threads({ limit: 2 })
    expect(first.threads.map((t) => t.id)).toEqual(['a:t-m5', 'a:t-m4'])
    const second = queries.threads({ limit: 2, before: first.nextBefore ?? 0 })
    expect(second.threads.map((t) => t.id)).toEqual(['a:t-m3', 'a:t-m2'])
  })

  it('filters by Label', () => {
    const { store, queries } = setup()
    store.putMessage('a', [], msg('m1', { labels: ['INBOX', 'Label_1'] }))
    store.putMessage('a', [], msg('m2', { labels: ['SENT'] }))
    expect(queries.threads({ labelId: 'a:Label_1' }).threads.map((t) => t.id)).toEqual(['a:t-m1'])
    expect(queries.threads({ inbox: true }).threads.map((t) => t.id)).toEqual(['a:t-m1'])
  })

  it('ignores saved Snooze state in the Inbox when disabled', () => {
    const { db, store, queries } = setup()
    const enabled = new MailStore(db, store.blobs, { snoozeEnabled: true })
    enabled.putMessage('a', [], msg('m1'))
    enabled.putMessage('a', [], msg('m2', { labels: ['INBOX', 'SPAM'] }))
    db.prepare('UPDATE thread SET snoozed_until = 2000').run()
    enabled.refreshThread('a:t-m1')
    enabled.refreshThread('a:t-m2')
    expect(new MailQueries(db, true).thread('a:t-m1')).toMatchObject({
      inInbox: false,
      snoozedUntil: 2000,
    })

    expect(queries.threads({ inbox: true }).threads).toMatchObject([
      { id: 'a:t-m1', inInbox: true, snoozedUntil: null },
    ])
    store.putMessage('a', [], msg('reply', { providerThreadId: 't-m1', sentAt: 3000 }))
    expect(
      db.prepare("SELECT in_inbox, snoozed_until FROM thread WHERE id = 'a:t-m1'").get(),
    ).toEqual({ in_inbox: 1, snoozed_until: 2000 })
    expect(queries.thread('a:t-m1')).toMatchObject({ inInbox: true, snoozedUntil: null })
  })

  it('searches the body, people and attachment names, accent-insensitive', () => {
    const { store, queries } = setup()
    store.putMessage('a', [], msg('m1', { bodyText: 'Das Angebot für Zürich', subject: 'Offer' }))
    store.putMessage(
      'a',
      [],
      msg('m2', {
        from: { name: 'Bob', address: 'bob@acme.com' },
        attachments: [
          {
            providerAttachmentId: 'x',
            filename: 'invoice-2026.pdf',
            mimeType: 'application/pdf',
            size: 1,
            contentId: null,
            inline: false,
          },
        ],
      }),
    )
    expect(queries.search('zurich').map((h) => h.id)).toEqual(['a:t-m1'])
    expect(queries.search('angeb').map((h) => h.id)).toEqual(['a:t-m1'])
    expect(queries.search('from:acme').map((h) => h.id)).toEqual(['a:t-m2'])
    expect(queries.search('invoice').map((h) => h.id)).toEqual(['a:t-m2'])
    expect(queries.search('"unbalanced')).toEqual([])
  })

  it('learns contacts from mail', () => {
    const { db, store } = setup()
    store.putMessage('a', ['owner@example.com'], msg('m1'))
    store.putMessage(
      'a',
      ['owner@example.com'],
      msg('m2', {
        from: { name: null, address: 'owner@example.com' },
        to: [{ name: 'Carol', address: 'Carol@x.com' }],
      }),
    )
    expect(
      db.prepare('SELECT address, received_count, sent_count FROM contact ORDER BY address').all(),
    ).toEqual([
      { address: 'alice@example.com', received_count: 1, sent_count: 0 },
      { address: 'carol@x.com', received_count: 0, sent_count: 1 },
    ])
  })
})

describe('toFtsQuery', () => {
  it('quotes terms and prefix-matches the last word', () => {
    expect(toFtsQuery('hello wor')).toBe('"hello" AND "wor"*')
    expect(toFtsQuery('from:bob "exact phrase"')).toBe('people : "bob" AND "exact phrase"*')
    expect(toFtsQuery('  ')).toBeNull()
    expect(toFtsQuery('a"b OR c')).toBe('"a""b" AND "OR" AND "c"*')
  })
})
