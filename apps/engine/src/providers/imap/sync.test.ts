import { expect, it } from 'vitest'
import { BlobStore } from '../../blobs.ts'
import { MailQueries } from '../../mail/queries.ts'
import { MailStore } from '../../mail/store.ts'
import { tempDir, testDb } from '../../test-support.ts'
import { FakeImap } from './fake.ts'
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
  expect(
    imap.requests.filter((request) => request.source).flatMap((request) => request.uids),
  ).toEqual([added])
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
