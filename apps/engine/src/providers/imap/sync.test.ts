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
  const queries = new MailQueries(db)
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

const longBody = `${'A line in a large message. '.repeat(32)}\r\n`

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
  const htmlBlob = queries.messageHtmlBlob(String(row?.message_id))
  expect(blobs.get(String(htmlBlob))?.toString().includes('<p>html end</p>')).toBe(true)
  expect(queries.search('startmarker', {})).toHaveLength(1)
  expect(queries.search('endmarker', {})).toHaveLength(0)
  const source = imap.folder('INBOX').messages.get(uid)?.source
  expect(source && blobs.get(String(row?.source_blob))?.equals(source)).toBe(true)
  expect(imap.downloads).toEqual([{ path: 'INBOX', uid, part: undefined }])
})

it.each(['message-id', 'email-id', 'header fingerprint'])(
  'deduplicates oversized copies using %s',
  async (identity) => {
    const { imap, db, makeSync, queries } = fixture()
    imap.addFolder('Archive', '\\Archive')
    const body = longBody.repeat(Math.ceil(LAZY_ATTACHMENT_THRESHOLD / longBody.length))
    for (const path of ['INBOX', 'Archive']) {
      const headers = ['Subject: Oversized copy']
      if (identity === 'message-id') headers.push('Message-ID: <oversized@example.com>')
      if (identity === 'email-id') headers.push(`X-Variant: ${path}`)
      const uid = imap.add(path, headers.join('\r\n'), body)
      const item = imap.folder(path).messages.get(uid)
      if (identity === 'email-id' && item) item.emailId = 'same-server-email-id'
    }
    await makeSync().step('all')
    expect(queries.accounts()[0]?.messageCount).toBe(1)
    expect(db.prepare('SELECT count(*) AS n FROM imap_location').get()?.n).toBe(2)
    expect(queries.threads({}).threads[0]?.labelIds).toEqual(['a:ARCHIVE', 'a:INBOX'])
  },
)

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

it.each([false, true])(
  'moves cached locations during role change and rename (OBJECTID: %s)',
  async (objectId) => {
    const { db, imap, makeSync, queries } = fixture()
    const folder = imap.addFolder('Filed')
    if (objectId) folder.mailboxId = 'mailbox-filed'
    for (let i = 1; i <= 40; i++) imap.add('Filed', `Subject: Filed ${i}`)
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
    if (objectId) expect(imap.downloads).toHaveLength(0)
  },
)

it.each([false, true])(
  'relabels the entire renamed folder with an oversized source (legacy cursor: %s)',
  async (legacyCursor) => {
    const { db, imap, makeSync, queries } = fixture()
    imap.addFolder('Filed')
    for (let i = 1; i <= 39; i++) imap.add('Filed', `Subject: Filed ${i}`)
    imap.add(
      'Filed',
      'Subject: Large filed message',
      longBody.repeat(Math.ceil(LAZY_ATTACHMENT_THRESHOLD / longBody.length)),
    )
    const sync = makeSync()
    expect(await sync.step('all')).toBe(false)
    expect(await sync.step('backfill')).toBe(true)
    const ids = db.prepare('SELECT id FROM message ORDER BY id').all()
    if (legacyCursor) {
      db.exec(`UPDATE account SET cursor = json_remove(cursor, '$.folders[1].exists')`)
    }
    imap.renameFolder('Filed', 'Renamed')
    imap.downloads.length = 0
    expect(await makeSync().step('all')).toBe(true)
    expect(queries.threads({ labelId: 'a:folder:Renamed' }).threads).toHaveLength(40)
    expect(db.prepare('SELECT id FROM message ORDER BY id').all()).toEqual(ids)
    expect(imap.downloads).toHaveLength(0)
  },
)

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
  const queries = new MailQueries(db)
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
