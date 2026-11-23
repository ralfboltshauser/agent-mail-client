import { describe, expect, it } from 'vitest'
import { BlobStore } from '../blobs.ts'
import { tempDir, testDb } from '../test-support.ts'
import { MailQueries } from './queries.ts'
import { mailSearch } from './search.ts'
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
    store.putMessage('a', [], msg('m1'))
    store.putMessage('a', [], msg('m2', { labels: ['INBOX', 'SPAM'] }))
    db.prepare('UPDATE thread SET snoozed_until = 2000').run()
    store.refreshThread('a:t-m1')
    store.refreshThread('a:t-m2')
    expect(new MailQueries(db, true).thread('a:t-m1')).toMatchObject({
      inInbox: true,
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

  it('applies directional people and UTC day filters to the same matching message', () => {
    const { store, queries } = setup()
    const alice = { name: 'Alice Baker', address: 'alice@example.test' }
    store.putMessage(
      'a',
      [],
      msg('sent', {
        to: [alice],
        bodyText: 'annual budget',
        sentAt: Date.parse('2026-11-23'),
      }),
    )
    store.putMessage(
      'a',
      [],
      msg('cc', {
        cc: [alice],
        bodyText: 'annual budget',
        sentAt: Date.parse('2026-11-23'),
      }),
    )
    store.putMessage(
      'a',
      [],
      msg('old', {
        from: alice,
        bodyText: 'annual budget',
        sentAt: Date.parse('2026-11-22'),
      }),
    )
    store.putMessage(
      'a',
      [],
      msg('fresh', {
        from: alice,
        bodyText: 'annual budget',
        sentAt: Date.parse('2026-11-23'),
      }),
    )
    store.putMessage(
      'a',
      [],
      msg('crossed', {
        providerThreadId: 't-sent',
        from: alice,
        bodyText: 'annual report',
        sentAt: Date.parse('2026-11-23'),
      }),
    )

    const query = 'from:ALICE@example.test "annual budget" after:2026-11-23 before:2026-11-24'
    expect(queries.search(query).map(({ id }) => id)).toEqual(['a:t-fresh'])
    expect(queries.search(query, { accountId: 'other' })).toEqual([])
    expect(queries.search('to:"Alice Baker"').map(({ id }) => id)).toEqual(['a:t-sent'])
    expect(queries.search('cc:alice@example.test').map(({ id }) => id)).toEqual(['a:t-cc'])
    expect(queries.search('from:alice@example.test after:2026-02-30')).toEqual([])
  })

  it('pages after deduplication even when one thread has over 2,000 matches', () => {
    const { db, store, queries } = setup()
    store.putMessage('a', [], msg('busy', { bodyText: 'meeting' }))
    store.putMessage('a', [], msg('other', { bodyText: `meeting ${'discuss '.repeat(50)}` }))
    db.exec(`
      WITH RECURSIVE numbers(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM numbers WHERE n < 2000)
      INSERT INTO message (id, account_id, thread_id, provider_id, body_text, sent_at)
      SELECT 'a:extra-' || n, 'a', 'a:t-busy', 'extra-' || n, 'meeting', 1000 FROM numbers
    `)
    expect(queries.search('meeting', { limit: 1 }).map(({ id }) => id)).toEqual(['a:t-busy'])
    expect(queries.search('meeting', { limit: 1, offset: 1 }).map(({ id }) => id)).toEqual([
      'a:t-other',
    ])
    expect(queries.search('meeting', { limit: 1, offset: 2 })).toEqual([])
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

describe('mailSearch', () => {
  it('quotes terms and prefix-matches the last word', () => {
    expect(mailSearch('hello wor')?.match).toBe('"hello" AND "wor"*')
    expect(mailSearch('from:bob "exact phrase"')?.match).toBe('"exact phrase"')
    expect(mailSearch('  ')).toBeNull()
    expect(mailSearch('a"b OR c')?.match).toBe('"a""b" AND "OR" AND "c"*')
  })
})
