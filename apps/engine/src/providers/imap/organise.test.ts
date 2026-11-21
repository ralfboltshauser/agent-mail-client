import { randomBytes, randomUUID } from 'node:crypto'
import type { OrganiseAction } from '@amc/protocol'
import { afterEach, expect, it, vi } from 'vitest'
import { BlobStore } from '../../blobs.ts'
import { Sealer } from '../../crypto.ts'
import { Mutations } from '../../mail/mutations.ts'
import { MailQueries } from '../../mail/queries.ts'
import { MailStore } from '../../mail/store.ts'
import { SyncManager } from '../../sync/manager.ts'
import { silentLog, tempDir, testDb } from '../../test-support.ts'
import { FakeImap } from './fake.ts'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
})

async function fixture({ archive = true, capability = 'MOVE', copyUid = true } = {}) {
  const db = testDb()
  const store = new MailStore(db, new BlobStore(tempDir()))
  const queries = new MailQueries(db)
  const sealer = new Sealer(randomBytes(32))
  const imap = new FakeImap()
  if (capability) imap.capabilities.set(capability, true)
  imap.reportCopyUid = copyUid
  if (archive) imap.addFolder('Filed mail', '\\Archive')
  else imap.addFolder('Archive')
  imap.addFolder('Deleted mail', '\\Trash')
  imap.addFolder('Project')
  const uid = imap.add('INBOX', 'Message-ID: <example@example.com>\r\nSubject: Organise me')
  db.prepare(
    "INSERT INTO account (id, kind, address, credentials, created_at) VALUES ('a', 'imap', 'owner@example.com', ?, 0)",
  ).run(sealer.seal({}))
  const imapClient = vi.fn(() => imap.client)
  const sync = new SyncManager({
    db,
    store,
    sealer,
    log: silentLog,
    imapClient,
    imapPollMs: 60_000,
    oauthClient: () => ({ clientId: '', clientSecret: '' }),
  })
  const queue = new Mutations(store, () => null, silentLog, {
    imap: (account, work) => sync.organiseImap(account, work),
  })
  cleanups.push(async () => {
    await Promise.all([sync.stop(), queue.stop()])
    db.close()
  })
  sync.start()
  await vi.waitFor(() => expect(queries.accounts()[0]?.status).toBe('ready'))
  const threadId = 'a:imap:example%40example.com'
  const view = () => queries.thread(threadId)
  const messageId = view()?.messages[0]?.id
  expect(messageId).toBeTruthy()
  type Input<T> = T extends { threadId?: string } ? Omit<T, 'threadId'> : never
  const enqueue = (action: Input<OrganiseAction>) => {
    const id = randomUUID()
    queue.submit('owner', [{ id, action: { ...action, threadId } }])
    return id
  }
  const settle = async (id: string) => {
    await queue.tick()
    const [result] = queue.lookup('owner', [id])
    expect(result?.status).not.toBe('pending')
    return result
  }
  const run = (action: Input<OrganiseAction>) => settle(enqueue(action))
  return { db, imap, imapClient, queue, queries, uid, messageId, view, enqueue, settle, run }
}

it('sets and clears Seen and Flagged and undoes acknowledged flag changes on the runner', async () => {
  const { imap, imapClient, uid, view, run } = await fixture()
  const flags = () => [...(imap.folder('INBOX').messages.get(uid)?.flags ?? [])]
  expect((await run({ kind: 'read', value: true }))?.messages?.[0]?.status).toBe('applied')
  expect(flags()).toEqual(['\\Seen'])
  expect(view()?.messages[0]).toMatchObject({ unread: false, labelIds: ['a:INBOX'] })
  await run({ kind: 'read', value: false })
  expect(flags()).toEqual([])
  await run({ kind: 'undo' })
  expect(flags()).toEqual(['\\Seen'])
  await run({ kind: 'star', value: true })
  expect(flags()).toEqual(['\\Seen', '\\Flagged'])
  await run({ kind: 'star', value: false })
  expect(flags()).toEqual(['\\Seen'])
  await run({ kind: 'undo' })
  expect(flags()).toEqual(['\\Seen', '\\Flagged'])
  expect(imapClient).toHaveBeenCalledTimes(1)
})

it('archives, trashes, and files mail with inverse moves and a stable single message after sync', async () => {
  const { imap, imapClient, db, messageId, view, run } = await fixture()
  const check = (path: string, label: string) => {
    expect(view()?.messages).toHaveLength(1)
    expect(view()?.messages[0]).toMatchObject({ id: messageId, labelIds: [label] })
    expect(db.prepare('SELECT message_id FROM imap_location').all()).toEqual([
      { message_id: messageId },
    ])
    expect(imap.folder(path).messages.size).toBe(1)
    expect([...imap.folders.values()].reduce((sum, folder) => sum + folder.messages.size, 0)).toBe(
      1,
    )
  }
  const move = async (action: Parameters<typeof run>[0], path: string, label: string) => {
    expect((await run(action))?.messages?.[0]?.status).toBe('applied')
    await vi.waitFor(() => check(path, label))
  }
  await move({ kind: 'archive' }, 'Filed mail', 'a:ARCHIVE')
  await move({ kind: 'undo' }, 'INBOX', 'a:INBOX')
  await move(
    { kind: 'label', labelId: 'a:folder:Project', value: true },
    'Project',
    'a:folder:Project',
  )
  await move({ kind: 'trash', value: true }, 'Deleted mail', 'a:TRASH')
  await move({ kind: 'undo' }, 'Project', 'a:folder:Project')
  await move({ kind: 'trash', value: true }, 'Deleted mail', 'a:TRASH')
  await move({ kind: 'trash', value: false }, 'INBOX', 'a:INBOX')
  expect(imapClient).toHaveBeenCalledTimes(1)
  // Wait for the runner's post-write reconciliation of Inbox and each destination.
  await vi.waitFor(() => {
    expect(imap.searches.some(({ path, uids }) => path === 'INBOX' && uids.includes(3))).toBe(true)
    check('INBOX', 'a:INBOX')
  })
})

it('keeps mute and its inverse in the Engine', async () => {
  const { imap, view, run } = await fixture()
  await run({ kind: 'mute', value: true })
  expect(view()).toMatchObject({ muted: true, inInbox: false, labelIds: ['a:INBOX'] })
  await run({ kind: 'mute', value: false })
  expect(view()).toMatchObject({ muted: false, inInbox: true })
  await run({ kind: 'undo' })
  expect(view()).toMatchObject({ muted: true, inInbox: false })
  expect(imap.writes).toEqual([])
})

it('supersedes an owner edit to the same flag and preserves independent flag edits', async () => {
  const { imap, uid, enqueue, settle, view } = await fixture()
  const read = enqueue({ kind: 'read', value: true })
  imap.flag('INBOX', uid, ['\\Seen'])
  expect((await settle(read))?.messages?.[0]?.status).toBe('superseded')
  expect(imap.writes).toEqual([])

  const star = enqueue({ kind: 'star', value: true })
  imap.flag('INBOX', uid, [])
  expect((await settle(star))?.messages?.[0]?.status).toBe('applied')
  expect(view()?.messages[0]).toMatchObject({ starred: true, unread: true })

  const undo = enqueue({ kind: 'undo' })
  imap.flag('INBOX', uid, [])
  expect((await settle(undo))?.messages?.[0]?.status).toBe('superseded')
  expect(imap.writes).toHaveLength(1)
})

it('supersedes an owner move before writing to the former UID', async () => {
  const { imap, uid, enqueue, settle } = await fixture()
  const archive = enqueue({ kind: 'archive' })
  const source = imap.folder('INBOX').messages.get(uid)
  if (!source) throw new Error('Missing fixture message')
  imap.folder('Project').messages.set(imap.folder('Project').nextUid++, source)
  imap.expunge('INBOX', uid)
  expect((await settle(archive))?.messages?.[0]?.status).toBe('superseded')
  expect(imap.writes).toEqual([])
})

it('requires a real Archive special-use folder', async () => {
  const { enqueue, imap } = await fixture({ archive: false })
  expect(() => enqueue({ kind: 'archive' })).toThrow('This IMAP Account has no Archive folder')
  expect(imap.writes).toEqual([])
  expect(imap.folder('Archive').messages.size).toBe(0)
})

it('requires MOVE or UIDPLUS and never runs mailbox-wide EXPUNGE', async () => {
  const { enqueue, imap } = await fixture({ capability: '' })
  expect(() => enqueue({ kind: 'archive' })).toThrow('This IMAP server does not support safe moves')
  expect(imap.writes).toEqual([])
})

it('falls back to UID COPY, Deleted, and UID EXPUNGE for just the source UID', async () => {
  const { imap, uid, messageId, view, run } = await fixture({ capability: 'UIDPLUS' })
  const other = imap.add('INBOX', 'Subject: Keep this deleted message', 'Other', ['\\Deleted'])
  expect((await run({ kind: 'archive' }))?.messages?.[0]?.status).toBe('applied')
  expect(imap.writes).toEqual([
    { command: 'UID COPY', path: 'INBOX', uid },
    { command: 'UID STORE +FLAGS', path: 'INBOX', uid },
    { command: 'UID EXPUNGE', path: 'INBOX', uid },
  ])
  expect([...imap.folder('INBOX').messages.keys()]).toEqual([other])
  expect(view()?.messages[0]).toMatchObject({ id: messageId, labelIds: ['a:ARCHIVE'] })
})

it('reconciles a native move without COPYUID and can undo it using the discovered UID', async () => {
  const { imap, messageId, view, run } = await fixture({ copyUid: false })
  expect((await run({ kind: 'archive' }))?.messages?.[0]?.status).toBe('applied')
  expect(view()?.messages[0]).toMatchObject({ id: messageId, labelIds: ['a:ARCHIVE'] })
  expect((await run({ kind: 'undo' }))?.messages?.[0]?.status).toBe('applied')
  expect(view()?.messages[0]).toMatchObject({ id: messageId, labelIds: ['a:INBOX'] })
  expect(imap.folder('Filed mail').messages.size).toBe(0)
})

it('reconciles a move whose response is lost without replaying it or offering an inverse', async () => {
  const { db, imap, messageId, view, run } = await fixture()
  const move = imap.messageMove.bind(imap)
  vi.spyOn(imap, 'messageMove').mockImplementationOnce(async (...args) => {
    await move(...args)
    return false
  })
  const result = await run({ kind: 'archive' })
  expect(result?.status).toBe('failed')
  expect(result?.messages?.[0]?.status).toBe('uncertain')
  expect(imap.writes).toHaveLength(1)
  expect(imap.folder('INBOX').messages.size).toBe(0)
  expect(imap.folder('Filed mail').messages.size).toBe(1)
  expect(db.prepare('SELECT message_id FROM imap_location').all()).toEqual([
    { message_id: messageId },
  ])
  expect(view()?.messages[0]).toMatchObject({ id: messageId, labelIds: ['a:ARCHIVE'] })
})
