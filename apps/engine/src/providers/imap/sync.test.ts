import { expect, it, vi } from 'vitest'
import { BlobStore } from '../../blobs.ts'
import { migrate, openDatabase } from '../../db/database.ts'
import { MIGRATIONS } from '../../db/migrations.ts'
import { MailQueries } from '../../mail/queries.ts'
import { MailStore } from '../../mail/store.ts'
import { tempDir, testDb } from '../../test-support.ts'
import { FakeImap } from './fake.ts'
import { LAZY_ATTACHMENT_THRESHOLD } from './mapping.ts'
import { ImapAccountSync } from './sync.ts'

function fixture(extensions: string[] = []) {
  const db = testDb()
  const blobs = new BlobStore(tempDir())
  const store = new MailStore(db, blobs)
  const imap = new FakeImap(extensions)
  db.prepare(
    "INSERT INTO account (id, kind, address, credentials, created_at) VALUES ('a', 'imap', 'owner@example.com', zeroblob(1), 0)",
  ).run()
  const queries = new MailQueries(db, false, blobs)
  const makeSync = () => new ImapAccountSync(imap.client, store, 'a', 'owner@example.com')
  return { db, blobs, store, queries, imap, makeSync }
}

it('backfills newest Inbox mail first, resumes older pages, and keeps only the folder Label', async () => {
  const { imap, makeSync, queries, db } = fixture()
  imap.addFolder('Filed/Sent Items', '\\Sent')
  imap.addFolder('Project')
  for (let i = 1; i <= 35; i++) {
    imap.add('INBOX', `Subject: Mail ${i}\r\nMessage-ID: <mail${i}@example.com>`, 'Welcome', [
      '\\Flagged',
    ])
  }
  imap.add('Filed/Sent Items', 'Subject: Sent mail')
  imap.add('Project', 'Subject: Project mail')

  expect(await makeSync().step('all')).toBe(false)
  const first = db.prepare('SELECT provider_id FROM message ORDER BY rowid LIMIT 3').all()
  expect(first.map((row) => row.provider_id)).toEqual(['INBOX:1:35', 'INBOX:1:34', 'INBOX:1:33'])
  expect(queries.accounts()[0]?.backfill).toMatchObject({ fetched: 34 })
  expect(queries.labels('a').map((label) => [label.providerId, label.kind])).toEqual([
    ['INBOX', 'system'],
    ['SENT', 'system'],
    ['folder:Project', 'user'],
  ])
  expect(await makeSync().step('all')).toBe(true)
  expect(queries.accounts()[0]?.backfill).toMatchObject({ phase: 'done', fetched: 37 })
  expect(queries.thread('a:imap:mail35%40example.com')?.messages[0]).toMatchObject({
    labelIds: ['a:INBOX'],
    unread: true,
    starred: true,
  })
})

it('publishes INTERNALDATE separately from the message Date', async () => {
  const { imap, makeSync, queries } = fixture()
  const uid = imap.add('INBOX', 'Message-ID: <delayed@example.com>')
  const deliveredAt = new Date('2026-11-21T12:00:00Z')
  const stored = imap.folder('INBOX').messages.get(uid)
  if (!stored) throw new Error('Missing fixture message')
  stored.internalDate = deliveredAt

  await makeSync().step('all')

  expect(queries.message('a:INBOX:1:1')).toMatchObject({
    sentAt: Date.parse('2026-11-21T10:00:00Z'),
    deliveredAt: deliveredAt.getTime(),
  })
})

it('retries a failed body page without skipping UIDs', async () => {
  const { imap, makeSync, queries } = fixture()
  imap.add('INBOX', 'Subject: Retry')
  imap.failFetch = true
  const sync = makeSync()
  await expect(sync.step('all')).rejects.toThrow('Fake FETCH failed')
  imap.failFetch = false
  expect(await sync.step('all')).toBe(true)
  expect(queries.accounts()[0]?.messageCount).toBe(1)
})

it.each([
  { extensions: [] },
  { extensions: ['CONDSTORE'] },
  { extensions: ['CONDSTORE', 'QRESYNC'] },
])('reconciles flags, deletions and additions with $extensions', async ({ extensions }) => {
  const { imap, makeSync, queries, store } = fixture(extensions)
  const removed = imap.add('INBOX', 'Subject: Remove')
  const kept = imap.add('INBOX', 'Subject: Keep')
  const sync = makeSync()
  await sync.step('all')

  imap.requests.length = 0
  imap.downloads.length = 0
  imap.expunge('INBOX', removed)
  imap.flag('INBOX', kept, ['\\Seen', '\\Flagged'])
  const added = imap.add('INBOX', 'Subject: Arrived')
  await sync.step('all')
  expect(store.hasMessage('a', `INBOX:1:${removed}`)).toBe(false)
  expect(store.hasMessage('a', `INBOX:1:${added}`)).toBe(true)
  const keptThread = queries
    .threads({ inbox: true })
    .threads.find((thread) => thread.subject === 'Keep')
  expect(keptThread).toMatchObject({ unreadCount: 0, starred: true, labelIds: ['a:INBOX'] })
  expect(imap.downloads.map(({ uid }) => uid)).toEqual([added])
  expect(imap.requests.some((request) => request.changedSince !== undefined)).toBe(
    extensions.includes('CONDSTORE'),
  )
})

it('replaces a changed UIDVALIDITY and removes a deleted folder without affecting other folders', async () => {
  const { imap, makeSync, store, queries } = fixture(['CONDSTORE', 'QRESYNC'])
  const archive = imap.addFolder('Archive', '\\Archive')
  imap.addFolder('Project:1')
  imap.add('INBOX', 'Subject: Old inbox')
  imap.add('Archive', 'Subject: Old archive')
  imap.add('Project:1', 'Subject: Project')
  const sync = makeSync()
  await sync.step('all')
  archive.validity = 2n
  archive.nextUid = 1
  archive.messages.clear()
  imap.add('Archive', 'Subject: New archive')
  imap.folders.delete('Project:1')
  await sync.step('all')
  expect(store.hasMessage('a', 'Archive:1:1')).toBe(false)
  expect(store.hasMessage('a', 'Archive:2:1')).toBe(true)
  expect(store.hasMessage('a', 'Project%3A1:1:1')).toBe(false)
  expect(store.hasMessage('a', 'INBOX:1:1')).toBe(true)
  expect(queries.labels('a').map((label) => label.providerId)).toEqual(['ARCHIVE', 'INBOX'])
})

it('restores Bucket metadata after an interrupted UIDVALIDITY reimport by Message-ID', async () => {
  const { imap, makeSync, queries, store } = fixture()
  const inbox = imap.folder('INBOX')
  imap.add('INBOX', 'Subject: Old parent\r\nMessage-ID: <old@example.com>')
  imap.add(
    'INBOX',
    'Subject: Re: Old parent\r\nMessage-ID: <keep@example.com>\r\nReferences: <old@example.com>',
  )
  const sync = makeSync()
  await sync.step('all')
  const oldId = 'a:imap:old%40example.com'
  store.setBucket({ threadId: oldId, bucket: 'Later', reason: 'Keep this reason' }, 'triage')
  const assignment = queries.threadSummary(oldId)?.bucket
  expect(assignment).toMatchObject({ bucket: 'Later', setBy: 'triage' })

  inbox.validity = 2n
  inbox.nextUid = 1
  inbox.messages.clear()
  imap.add('INBOX', 'Subject: Different mail\r\nMessage-ID: <different@example.com>')
  imap.add('INBOX', 'Subject: Kept mail, reimported\r\nMessage-ID: <keep@example.com>')
  imap.failFetch = true
  await expect(sync.step('all')).rejects.toThrow('Fake FETCH failed')
  sync.dispose()
  expect(queries.threadSummary(oldId)).toBeNull()

  imap.failFetch = false
  await makeSync().step('all')
  expect(queries.threadSummary('a:imap:keep%40example.com')?.bucket).toEqual(assignment)
  expect(queries.threadSummary('a:imap:different%40example.com')?.bucket).toBeNull()
})

it.each([false, true])(
  'preserves Buckets on a reference merge (target assigned: %s)',
  async (targetAssigned) => {
    const { imap, makeSync, queries, store } = fixture()
    imap.add('INBOX', 'Subject: Destination\r\nMessage-ID: <target@example.com>')
    imap.add('INBOX', 'Subject: Source\r\nMessage-ID: <source@example.com>')
    const sync = makeSync()
    await sync.step('all')
    const sourceId = 'a:imap:source%40example.com'
    const targetId = 'a:imap:target%40example.com'
    store.setBucket({ threadId: sourceId, bucket: 'Reply', reason: 'Source reason' }, 'triage')
    if (targetAssigned)
      store.setBucket({ threadId: targetId, bucket: 'Later', reason: 'Target reason' }, 'owner')
    const assignment = queries.threadSummary(targetAssigned ? targetId : sourceId)?.bucket
    expect(assignment).toMatchObject({ bucket: targetAssigned ? 'Later' : 'Reply' })

    imap.add(
      'INBOX',
      'Subject: Bridge\r\nMessage-ID: <bridge@example.com>\r\nReferences: <target@example.com> <source@example.com>',
    )
    await sync.step('all')
    expect(queries.threadSummary(sourceId)).toBeNull()
    expect(queries.threadSummary(targetId)).toMatchObject({ messageCount: 3, bucket: assignment })
  },
)

it('joins reference containers across folders and saves real MIME attachment bytes', async () => {
  const { imap, makeSync, queries, blobs } = fixture()
  imap.addFolder('Sent', '\\Sent')
  imap.add('INBOX', 'Subject: First\r\nMessage-ID: <first@example.com>')
  imap.add(
    'INBOX',
    'Subject: Re: First\r\nReferences: <middle@example.com>\r\nMessage-ID: <last@example.com>',
  )
  imap.add(
    'Sent',
    'Subject: Re: First\r\nReferences: <first@example.com>\r\nMessage-ID: <middle@example.com>\r\nContent-Type: multipart/mixed; boundary="test"',
    [
      '--test',
      'Content-Type: text/html; charset=utf-8',
      '',
      '<p>Attached</p>',
      '--test',
      'Content-Type: text/plain; name="example.txt"',
      'Content-Disposition: attachment; filename="example.txt"',
      '',
      'Some bytes',
      '--test--',
    ].join('\r\n'),
  )

  await makeSync().step('all')
  const threads = queries.threads({}).threads
  expect(threads).toHaveLength(1)
  const thread = queries.thread(threads[0]?.id ?? '')
  expect(thread?.messages).toHaveLength(3)
  const withAttachment = thread?.messages.find((message) => message.attachments.length)
  const attachment = withAttachment?.attachments[0]
  expect(attachment?.filename).toBe('example.txt')
  expect(withAttachment?.bodyText).toBe('Attached')
  const row = queries.db
    .prepare('SELECT blob FROM attachment WHERE id = ?')
    .get(attachment?.id ?? '')
  expect(blobs.get(String(row?.blob))?.toString()).toBe('Some bytes')
})

it('uses a nearby reply subject when References and In-Reply-To are absent', async () => {
  const { imap, makeSync, queries } = fixture()
  imap.add('INBOX', 'Subject: Test subject\r\nMessage-ID: <parent@example.com>')
  imap.add('INBOX', 'Subject: Re: Test subject\r\nMessage-ID: <child@example.com>')
  await makeSync().step('all')
  expect(queries.threads({}).threads.map((thread) => thread.messageCount)).toEqual([2])
})

it('removes the highest expunged UID after reconnecting with QRESYNC', async () => {
  const { db, imap, makeSync, queries } = fixture(['CONDSTORE', 'QRESYNC'])
  imap.add('INBOX', 'Subject: Keep')
  const highest = imap.add('INBOX', 'Subject: Expunge')
  await makeSync().step('all')
  imap.close()
  imap.expunge('INBOX', highest)
  await imap.connect()
  await makeSync().step('all')
  expect(queries.threads({}).threads.map(({ subject }) => subject)).toEqual(['Keep'])
  expect(
    JSON.parse(String(db.prepare('SELECT cursor FROM account').get()?.cursor)).folders[0],
  ).toMatchObject({ modseq: String(imap.folder('INBOX').modseq) })
})

it('counts identical copies once and preserves the surviving folder after one copy is expunged', async () => {
  const { imap, makeSync, queries } = fixture()
  imap.addFolder('Archive', '\\Archive')
  const headers = 'Subject: Shared\r\nMessage-ID: <shared@example.com>'
  const inbox = imap.add('INBOX', headers, 'Same bytes')
  const archive = imap.add('Archive', headers, 'Same bytes', ['\\Seen'])
  imap.add('Archive', headers, 'Different bytes')
  await makeSync().step('all')
  const tid = 'a:imap:shared%40example.com'
  const thread = () => queries.thread(tid)
  expect(queries.threads({}).threads[0]?.messageCount).toBe(2)
  const shared = thread()?.messages.find(({ labelIds }) => labelIds.includes('a:INBOX'))
  expect(shared).toMatchObject({ labelIds: ['a:ARCHIVE', 'a:INBOX'], unread: true })

  imap.expunge('INBOX', inbox)
  await makeSync().step('all')
  expect(thread()?.messages.find(({ id }) => id === shared?.id)).toMatchObject({
    labelIds: ['a:ARCHIVE'],
    unread: false,
  })
  imap.expunge('Archive', archive)
  await makeSync().step('all')
  expect(queries.threads({}).threads[0]?.messageCount).toBe(1)
  expect(thread()?.messages[0]?.id).not.toBe(shared?.id)
})

it.each([
  ['BOM only', '//4='],
  ['whitespace only', '//4gAAkA'],
])('uses HTML when the decoded plain alternative is %s', async (_label, encodedPlain) => {
  const { imap, makeSync, queries, blobs } = fixture()
  imap.add(
    'INBOX',
    'Subject: HTML fallback\r\nMIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary=outer',
    [
      '--outer',
      'Content-Type: multipart/alternative; boundary=alt',
      '',
      '--alt',
      'Content-Type: text/plain; charset=utf-16le',
      'Content-Transfer-Encoding: base64',
      '',
      encodedPlain,
      '--alt',
      'Content-Type: text/html; charset=utf-8',
      '',
      '<p>Actual message</p>',
      '--alt--',
      '--outer--',
    ].join('\r\n'),
  )

  await makeSync().step('all')

  const [thread] = queries.threads({}).threads
  const message = queries.thread(thread?.id ?? '')?.messages[0]
  expect(message).toMatchObject({ bodyText: 'Actual message', snippet: 'Actual message' })
  expect(queries.messageHtml(message?.id ?? '', blobs)).toBe('<p>Actual message</p>')
  expect(queries.search('actual', {})).toHaveLength(1)
})

const longBody = `${'A line in a large message. '.repeat(32)}\r\n`

it.each(['<img src="data:image/png;base64,', '<img alt="sample > text" src="', '<!-- '])(
  'keeps clipped HTML markup out of IMAP snippets and search (%s)',
  async (start) => {
    const { imap, makeSync, blobs, queries } = fixture()
    const close = start.startsWith('<!--') ? '-->' : '">'
    const html = `<p>Visible content</p>${start}${'hiddenpayload '.repeat(50_000)}${close}<p>Actual message</p>`
    imap.add(
      'INBOX',
      'Subject: Clipped HTML\r\nContent-Type: multipart/mixed; boundary=body',
      `--body\r\nContent-Type: text/html; charset=UTF-8\r\n\r\n${html}\r\n--body--`,
    )
    await makeSync().step('all')
    const [thread] = queries.threads({}).threads
    expect(thread?.snippet).toBe('Visible content')
    const [message] = queries.thread(thread?.id ?? '')?.messages ?? []
    expect(message?.bodySearchTruncated).toBe(true)
    expect(queries.search('visible', {})).toHaveLength(1)
    expect(queries.search('hiddenpayload', {})).toHaveLength(0)
    expect(queries.messageHtml(message?.id ?? '', blobs)).toContain('<p>Actual message</p>')
  },
)

it('stores oversized raw and displayed bodies completely and marks the FTS prefix', async () => {
  const { imap, makeSync, db, blobs, queries } = fixture()
  const lines = longBody.repeat(
    Math.ceil((LAZY_ATTACHMENT_THRESHOLD + 128 * 1024) / longBody.length),
  )
  const text = `startmarker\r\n${lines}\r\nendmarker`
  const html = `<p>html start</p>${'<p>HTML line</p>\r\n'.repeat(20_000)}<p>html end</p>`
  const uid = imap.add(
    'INBOX',
    'Subject: Large body\r\nContent-Type: multipart/alternative; boundary="body"',
    `--body\r\nContent-Type: text/plain\r\n\r\n${text}\r\n--body\r\nContent-Type: text/html\r\n\r\n${html}\r\n--body--`,
  )
  await makeSync().step('all')

  const row = db.prepare('SELECT message_id, source_blob FROM imap_location').get()
  const message = queries.message(String(row?.message_id))
  expect(message?.bodyText.startsWith('startmarker')).toBe(true)
  expect(message?.bodyText.endsWith('endmarker')).toBe(true)
  expect(message?.bodyText.length).toBeGreaterThan(16 * 1024 * 1024)
  expect(message?.bodySearchTruncated).toBe(true)
  expect(message?.hasHtml).toBe(true)
  expect(queries.messageHtml(String(row?.message_id), blobs)).toContain('<p>html end</p>')
  expect(queries.search('startmarker', {})).toHaveLength(1)
  expect(queries.search('endmarker', {})).toHaveLength(0)
  const source = imap.folder('INBOX').messages.get(uid)?.source
  expect(source && blobs.get(String(row?.source_blob))?.equals(source)).toBe(true)
  expect(imap.downloads).toEqual([{ path: 'INBOX', uid, part: undefined }])
})

it('bounds peak decoded heap during sync for large encoded text and HTML', async () => {
  const { imap, makeSync, db, queries, blobs } = fixture()
  const mib = 1024 * 1024
  const encode = (body: string, encoding: BufferEncoding = 'utf8') =>
    Buffer.from(body, encoding).toString('base64')
  imap.add(
    'INBOX',
    'Subject: Encoded bodies\r\nContent-Type: multipart/alternative; boundary="encoded"',
    [
      '--encoded',
      'Content-Type: text/plain; charset=utf-8',
      'Content-Transfer-Encoding: base64',
      '',
      encode(`firstword\n${'a'.repeat(32 * mib)}\nlastword`),
      '--encoded',
      'Content-Type: text/html; charset=iso-8859-1',
      'Content-Transfer-Encoding: base64',
      '',
      encode(`<p>Début</p>${'b'.repeat(24 * mib)}<p>Terminé</p>`, 'latin1'),
      '--encoded--',
    ].join('\r\n'),
  )

  const start = process.memoryUsage().heapUsed
  let peak = start
  const measure = () => {
    peak = Math.max(peak, process.memoryUsage().heapUsed)
  }
  const timer = setInterval(measure, 5)
  try {
    await makeSync().step('all')
    measure()
  } finally {
    clearInterval(timer)
  }
  expect(peak - start).toBeLessThan(24 * mib)

  const stored = db.prepare('SELECT id, length(body_text) AS length FROM message').get()
  const id = String(stored?.id)
  expect(stored?.length).toBe(256 * 1024)
  expect(queries.message(id)?.bodyText.endsWith('lastword')).toBe(true)
  expect(queries.message(id)?.bodySearchTruncated).toBe(true)
  const html = queries.messageHtml(id, blobs)
  expect(html?.startsWith('<p>Début</p>')).toBe(true)
  expect(html?.endsWith('<p>Terminé</p>')).toBe(true)
  expect(queries.search('firstword', {})).toHaveLength(1)
  expect(queries.search('lastword', {})).toHaveLength(0)
}, 30_000)

it.each(['Message-ID: <oversized@example.com>', 'X-No-Message-ID: true'])(
  'deduplicates byte-identical oversized copies with %s',
  async (header) => {
    const { imap, db, makeSync, queries } = fixture()
    imap.addFolder('Archive', '\\Archive')
    const body = longBody.repeat(Math.ceil(LAZY_ATTACHMENT_THRESHOLD / longBody.length))
    for (const path of ['INBOX', 'Archive']) {
      imap.add(path, `Subject: Oversized copy\r\n${header}`, body)
    }
    await makeSync().step('all')
    expect(imap.downloads.map(({ path }) => path)).toEqual(['INBOX', 'Archive'])
    expect(queries.accounts()[0]?.messageCount).toBe(1)
    expect(db.prepare('SELECT count(*) AS n FROM imap_location').get()?.n).toBe(2)
    expect(queries.threads({}).threads[0]?.labelIds).toEqual(['a:ARCHIVE', 'a:INBOX'])
  },
)

it('keeps different downloaded bodies separate when EMAILID is reused', async () => {
  const { imap, db, makeSync } = fixture()
  imap.addFolder('Archive', '\\Archive')
  for (const [path, body] of [
    ['INBOX', 'body A'],
    ['Archive', 'body B'],
  ] as const) {
    const uid = imap.add(path, 'Subject: Same EMAILID', body)
    const message = imap.folder(path).messages.get(uid)
    if (!message) throw new Error('Missing fake message')
    message.emailId = 'shared-email-id'
  }

  await makeSync().step('all')

  expect(db.prepare('SELECT body_text FROM message ORDER BY body_text').all()).toEqual([
    { body_text: 'body A' },
    { body_text: 'body B' },
  ])
})

it('keeps same-size oversized messages with identical headers and different bodies separate', async () => {
  const { db, imap, makeSync, queries } = fixture()
  imap.addFolder('Archive', '\\Archive')
  const common = longBody.repeat(Math.ceil(LAZY_ATTACHMENT_THRESHOLD / longBody.length))
  const headers = 'Subject: No optional identifiers'
  const inbox = imap.add('INBOX', headers, `${common}body A`)
  const archive = imap.add('Archive', headers, `${common}body B`)
  expect(imap.folder('INBOX').messages.get(inbox)?.source.length).toBe(
    imap.folder('Archive').messages.get(archive)?.source.length,
  )
  await makeSync().step('all')

  const locations = db.prepare('SELECT path_key, message_id, source_blob FROM imap_location').all()
  expect(new Set(locations.map(({ source_blob }) => source_blob)).size).toBe(2)
  expect(queries.accounts()[0]?.messageCount).toBe(2)
  const inboxId = String(locations.find(({ path_key }) => path_key === 'INBOX')?.message_id)
  const archiveId = String(locations.find(({ path_key }) => path_key === 'Archive')?.message_id)
  expect(queries.message(inboxId)?.bodyText.endsWith('body A')).toBe(true)
  expect(queries.message(archiveId)?.bodyText.endsWith('body B')).toBe(true)

  imap.expunge('INBOX', inbox)
  await makeSync().step('all')
  expect(queries.message(inboxId)).toBeNull()
  expect(queries.message(archiveId)?.bodyText.endsWith('body B')).toBe(true)
  expect(queries.message(archiveId)?.labelIds).toEqual(['a:ARCHIVE'])
})

it('downloads a replacement folder with identical metadata and displays its new body', async () => {
  const { db, imap, makeSync, queries } = fixture()
  const headers = [
    'Subject: Shared subject',
    'Message-ID: <reused@example.com>',
    'Date: Wed, 18 Nov 2026 10:00:00 +0000',
    'From: Test Sender <sender@example.com>',
    'To: Owner <owner@example.com>',
  ].join('\r\n')
  imap.addFolder('Old')
  const oldUid = imap.add('Old', headers, 'old content')
  const oldSize = imap.folder('Old').messages.get(oldUid)?.source.length
  const sync = makeSync()
  await sync.step('all')
  const oldBox = await imap.mailboxOpen('Old')
  const oldId = String(db.prepare('SELECT message_id FROM imap_location').get()?.message_id)
  expect(queries.message(oldId)?.bodyText).toBe('old content')

  imap.folders.delete('Old')
  imap.addFolder('New')
  const uid = imap.add('New', headers, 'new content')
  const newBox = await imap.mailboxOpen('New')
  expect([newBox.uidValidity, newBox.uidNext, newBox.exists, uid]).toEqual([
    oldBox.uidValidity,
    oldBox.uidNext,
    oldBox.exists,
    oldUid,
  ])
  expect(imap.folder('New').messages.get(uid)?.source.length).toBe(oldSize)
  imap.downloads.length = 0

  expect(await sync.step('all')).toBe(true)
  expect(await makeSync().step('all')).toBe(true)

  expect(imap.downloads).toEqual([{ path: 'New', uid, part: undefined }])
  expect(queries.message(oldId)).toBeNull()
  const locations = db.prepare('SELECT path_key, message_id FROM imap_location').all()
  expect(locations).toMatchObject([{ path_key: 'New' }])
  expect(queries.message(String(locations[0]?.message_id))).toMatchObject({
    bodyText: 'new content',
    labelIds: ['a:folder:New'],
  })
})

it('rejects a partial source and retries the same UID', async () => {
  const { imap, makeSync, queries } = fixture()
  imap.add('INBOX', 'Subject: Partial', 'Some body')
  const original = imap.download.bind(imap)
  imap.download = (range, part, opts) => original(range, part, { ...opts, maxBytes: 16 })
  const sync = makeSync()
  await expect(sync.step('all')).rejects.toThrow('Blob size differs from the expected size')
  expect(queries.accounts()[0]?.messageCount).toBe(0)
  imap.download = original
  await sync.step('all')
  expect(queries.accounts()[0]?.messageCount).toBe(1)
})

it('pages both backfill and UID reconciliation without requesting full sources with FETCH', async () => {
  const { imap, makeSync, queries, db } = fixture()
  for (let i = 1; i <= 97; i++) imap.add('INBOX', `Subject: Paged ${i}`)
  expect(await makeSync().step('all')).toBe(false)
  expect(imap.searches.map(({ uids }) => uids.length)).toEqual([32])
  expect(imap.downloads.map(({ uid }) => uid)).toEqual(Array.from({ length: 32 }, (_, i) => 97 - i))
  const { source_blob } =
    db.prepare('SELECT source_blob FROM imap_location WHERE uid = 97').get() ?? {}
  expect(typeof source_blob).toBe('string')
  imap.expunge('INBOX', 90)
  imap.expunge('INBOX', 30)
  const resumed = makeSync()
  while (!(await resumed.step('all'))) {
    // Resume until the oldest page.
  }
  expect(imap.searches.some(({ uids }) => uids.length > 32)).toBe(true)
  expect(imap.searches.every(({ uids }) => uids.length <= 512)).toBe(true)
  expect(imap.requests.every(({ source }) => !source)).toBe(true)
  expect(queries.accounts()[0]?.messageCount).toBe(95)
})

it('moves cached locations during a role change and a MAILBOXID-confirmed rename', async () => {
  const { db, imap, makeSync, queries } = fixture()
  const folder = imap.addFolder('Filed')
  folder.mailboxId = 'mailbox-filed'
  for (let i = 1; i <= 40; i++) {
    imap.add('Filed', `Subject: Filed ${i}\r\nMessage-ID: <filed${i}@example.com>`)
  }
  const sync = makeSync()
  expect(await sync.step('all')).toBe(false)
  const cached = db.prepare('SELECT id FROM message ORDER BY rowid LIMIT 1').get()?.id
  folder.specialUse = '\\Archive'
  await makeSync().step('all')
  expect(
    db.prepare('SELECT label_ids FROM message WHERE id = ?').get(cached ?? '')?.label_ids,
  ).toBe('["a:ARCHIVE"]')
  expect(queries.threads({ labelId: 'a:ARCHIVE' }).threads).toHaveLength(40)

  imap.renameFolder('Filed', 'Renamed')
  folder.specialUse = undefined
  imap.downloads.length = 0
  await makeSync().step('all')
  expect(
    db.prepare('SELECT label_ids FROM message WHERE id = ?').get(cached ?? '')?.label_ids,
  ).toBe('["a:folder:Renamed"]')
  expect(queries.threads({ labelId: 'a:folder:Renamed' }).threads).toHaveLength(40)
  expect(imap.downloads).toHaveLength(0)
})

it('keeps chronological summary fields and flags when all thread messages share a timestamp', async () => {
  const { imap, makeSync, queries } = fixture()
  imap.add('INBOX', 'Subject: Latest message\r\nMessage-ID: <summary@example.com>', 'Latest body', [
    '\\Flagged',
  ])
  imap.add('INBOX', 'Subject: First message\r\nMessage-ID: <summary@example.com>', 'First body', [
    '\\Seen',
  ])
  await makeSync().step('all')
  expect(queries.threads({}).threads).toMatchObject([
    {
      subject: 'First message',
      snippet: 'Latest body',
      messageCount: 2,
      unreadCount: 1,
      starred: true,
      participants: [{ address: 'sender@example.com', name: null }],
    },
  ])
})

it('services Inbox IDLE between reconciliation batches in a large folder', async () => {
  const { imap, makeSync, queries } = fixture(['CONDSTORE'])
  imap.addFolder('Archive')
  for (let i = 1; i <= 520; i++) imap.add('Archive', `Subject: Archive ${i}`)
  await imap.connect()
  const sync = makeSync()
  await sync.step('all')
  while (!(await sync.step('backfill'))) {
    // Fill the cache before testing reconciliation.
  }
  let now = 0
  const clock = vi.spyOn(performance, 'now').mockImplementation(() => now)
  let archiveSearches = 0
  let presentBeforeSecondBatch = false
  imap.onSearch = (path) => {
    if (path !== 'Archive') return
    if (++archiveSearches === 1) now = 1_100
    else if (archiveSearches === 2) {
      presentBeforeSecondBatch = queries
        .threads({ inbox: true })
        .threads.some(({ subject }) => subject === 'Delivery during reconciliation')
    }
  }
  imap.onIdle = () => {
    if (archiveSearches === 1) imap.add('INBOX', 'Subject: Delivery during reconciliation')
  }
  try {
    await sync.step('all', async () => {
      await sync.waitForInbox(1, new AbortController().signal)
      if (sync.inboxChanged) await sync.step('inbox')
    })
    expect(archiveSearches).toBe(2)
    expect(presentBeforeSecondBatch).toBe(true)
  } finally {
    clock.mockRestore()
    sync.dispose()
  }
}, 15_000)

it('jumps over sparsely allocated UIDs using bounded sequence searches', async () => {
  const { imap, makeSync, queries } = fixture()
  imap.add('INBOX', 'Subject: Old UID')
  imap.folder('INBOX').nextUid = 4_000_000_000
  imap.add('INBOX', 'Subject: High UID')
  const sync = makeSync()
  expect(await sync.step('all')).toBe(false)
  expect(await sync.step('backfill')).toBe(true)
  expect(imap.searches.length).toBeLessThan(8)
  expect(imap.downloads.map(({ uid }) => uid)).toEqual([4_000_000_000, 1])
  expect(queries.accounts()[0]?.messageCount).toBe(2)
})

it('upgrades cached folder-specific copies without first deleting the legacy messages', async () => {
  const db = openDatabase(':memory:')
  migrate(db, { migrations: MIGRATIONS.filter(({ version }) => version <= 3) })
  const imap = new FakeImap()
  imap.addFolder('Archive', '\\Archive')
  for (const path of ['INBOX', 'Archive']) {
    imap.add(path, 'Subject: Legacy copy\r\nMessage-ID: <legacy@example.com>')
  }
  db.prepare(
    "INSERT INTO account (id, kind, address, credentials, cursor, created_at) VALUES ('a', 'imap', 'owner@example.com', x'00', ?, 0)",
  ).run(
    JSON.stringify({
      folders: ['INBOX', 'Archive'].map((path) => ({
        path,
        validity: '1',
        highUid: 1,
        before: 0,
        modseq: null,
      })),
    }),
  )
  db.exec(`
    INSERT INTO thread (id, account_id, provider_thread_id) VALUES ('a:legacy', 'a', 'legacy');
    INSERT INTO message (id, account_id, thread_id, provider_id, rfc_message_id, label_ids, sent_at)
      VALUES ('a:INBOX:1:1', 'a', 'a:legacy', 'INBOX:1:1', '<legacy@example.com>', '["a:INBOX"]', 0),
             ('a:Archive:1:1', 'a', 'a:legacy', 'Archive:1:1', '<legacy@example.com>', '["a:ARCHIVE"]', 0);
  `)
  migrate(db)
  expect(db.prepare('SELECT count(*) AS count FROM message').get()?.count).toBe(2)
  const store = new MailStore(db, new BlobStore(tempDir()))
  await new ImapAccountSync(imap.client, store, 'a', 'owner@example.com').step('all')
  expect(new MailQueries(db).thread('a:legacy')?.messages).toMatchObject([
    { id: 'a:INBOX:1:1', labelIds: ['a:ARCHIVE', 'a:INBOX'] },
  ])
  expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([])
  db.close()
})

it('replaces a v4 preview with the full source under the cached message ID', async () => {
  const db = openDatabase(':memory:')
  migrate(db, { migrations: MIGRATIONS.filter(({ version }) => version <= 4) })
  const imap = new FakeImap()
  imap.add(
    'INBOX',
    'Message-ID: <preview@example.com>\r\nSubject: Legacy preview',
    `Start of the body\r\n${longBody.repeat(Math.ceil(LAZY_ATTACHMENT_THRESHOLD / longBody.length))}\r\nRest of the body`,
  )
  db.exec(`
    INSERT INTO account (id, kind, address, credentials, cursor, created_at)
      VALUES ('a', 'imap', 'owner@example.com', x'00',
        '{"folders":[{"path":"INBOX","validity":"1","highUid":1,"before":0,"modseq":null}]}', 0);
    INSERT INTO thread (id, account_id, provider_thread_id)
      VALUES ('a:imap:preview%40example.com', 'a', 'imap:preview%40example.com');
    INSERT INTO message (id, account_id, thread_id, provider_id, rfc_message_id, body_text, sent_at)
      VALUES ('a:INBOX:1:1', 'a', 'a:imap:preview%40example.com', 'INBOX:1:1',
        '<preview@example.com>', 'Start of the body', 0);
    INSERT INTO imap_location (account_id, path_key, validity, uid, message_id, label_id, unread, starred)
      VALUES ('a', 'INBOX', '1', 1, 'a:INBOX:1:1', 'a:INBOX', 1, 0);
  `)
  migrate(db)
  const store = new MailStore(db, new BlobStore(tempDir()))
  const queries = new MailQueries(db, false, store.blobs)
  expect(queries.message('a:INBOX:1:1')?.bodyText).toBe('Start of the body')
  await new ImapAccountSync(imap.client, store, 'a', 'owner@example.com').step('all')
  const message = queries.message('a:INBOX:1:1')
  expect(message?.bodyText.endsWith('Rest of the body')).toBe(true)
  expect(message?.bodySearchTruncated).toBe(true)
  expect(db.prepare('SELECT verified, source_blob FROM imap_location').get()).toMatchObject({
    verified: 1,
    source_blob: expect.any(String),
  })
})

it.each([
  { schema: 5, fingerprint: 'headers:legacy' },
  { schema: 6, fingerprint: 'email-id:legacy' },
])(
  'splits distinct sources combined by a v$schema metadata fingerprint',
  async ({ schema, fingerprint }) => {
    const db = openDatabase(':memory:')
    migrate(db, { migrations: MIGRATIONS.filter(({ version }) => version <= schema) })
    const imap = new FakeImap()
    const blobs = new BlobStore(tempDir())
    imap.addFolder('Archive', '\\Archive')
    const sources = ['INBOX', 'Archive'].map((path, i) => {
      const uid = imap.add(path, 'Subject: Legacy collision', `body ${i}`)
      const source = imap.folder(path).messages.get(uid)
      if (!source) throw new Error('Missing fake message')
      return [path, blobs.put(source.source)] as const
    })
    db.exec(`
    INSERT INTO account (id, kind, address, credentials, cursor, created_at)
      VALUES ('a', 'imap', 'owner@example.com', x'00',
        '{"folders":[{"path":"INBOX","validity":"1","highUid":1,"before":0,"modseq":null},
        {"path":"Archive","validity":"1","highUid":1,"before":0,"modseq":null}]}', 0);
    INSERT INTO thread (id, account_id, provider_thread_id) VALUES ('a:legacy', 'a', 'legacy');
    INSERT INTO message (id, account_id, thread_id, provider_id, imap_fingerprint, body_text, sent_at)
      VALUES ('a:INBOX:1:1', 'a', 'a:legacy', 'INBOX:1:1', '${fingerprint}', 'body 0', 0);
  `)
    for (const [path, source] of sources) {
      db.prepare(`
      INSERT INTO imap_location (account_id, path_key, validity, uid, message_id, label_id, unread, starred, source_blob)
      VALUES ('a', ?, '1', 1, 'a:INBOX:1:1', ?, 1, 0, ?)
    `).run(path, `a:${path.toUpperCase()}`, source)
    }

    migrate(db)
    const store = new MailStore(db, blobs)
    await new ImapAccountSync(imap.client, store, 'a', 'owner@example.com').step('all')
    expect(db.prepare('SELECT body_text FROM message ORDER BY body_text').all()).toEqual([
      { body_text: 'body 0' },
      { body_text: 'body 1' },
    ])
    expect(db.prepare('SELECT count(*) AS n FROM imap_location WHERE verified = 1').get()?.n).toBe(
      2,
    )
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([])
    db.close()
  },
)
