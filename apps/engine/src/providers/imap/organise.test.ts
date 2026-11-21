import { randomBytes, randomUUID } from 'node:crypto'
import type { OrganiseAction } from '@amc/protocol'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { afterEach, expect, it, vi } from 'vitest'
import { authenticate, issueToken } from '../../auth/tokens.ts'
import { BlobStore } from '../../blobs.ts'
import { Sealer } from '../../crypto.ts'
import { organizeAsAgent } from '../../mail/agent-actions.ts'
import { Drafts } from '../../mail/drafts.ts'
import { Mutations } from '../../mail/mutations.ts'
import { MailQueries } from '../../mail/queries.ts'
import { MailStore } from '../../mail/store.ts'
import { buildMcpServer } from '../../mcp/server.ts'
import { SyncManager } from '../../sync/manager.ts'
import { silentLog, tempDir, testDb } from '../../test-support.ts'
import { FakeImap } from './fake.ts'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
})

async function fixture({
  archive = true,
  capability = 'MOVE',
  copyUid = true,
  secondaryTrash = false,
} = {}) {
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
  if (secondaryTrash) imap.addFolder('Secondary Deleted', '\\Trash')
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
  await vi.waitFor(() => expect(queries.accounts()[0]?.status).toBe('ready'), { timeout: 3000 })
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
  return {
    db,
    imap,
    imapClient,
    queue,
    queries,
    store,
    threadId,
    uid,
    messageId,
    view,
    enqueue,
    settle,
    run,
  }
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
  const { enqueue, imap, run } = await fixture({ capability: '' })
  expect(() => enqueue({ kind: 'archive' })).toThrow('This IMAP server does not support safe moves')
  expect(() => enqueue({ kind: 'trash', value: true })).toThrow('does not support safe moves')
  expect(() => enqueue({ kind: 'label', labelId: 'a:folder:Project', value: true })).toThrow(
    'does not support safe moves',
  )
  expect((await run({ kind: 'star', value: true }))?.status).toBe('applied')
  expect(imap.writes.map(({ command }) => command)).toEqual(['UID STORE +FLAGS'])
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

it('syncs an acknowledged move without COPYUID and refuses to undo an identical replacement', async () => {
  const { imap, messageId, view, run, enqueue } = await fixture({ copyUid: false })
  const move = imap.uidMove.bind(imap)
  vi.spyOn(imap, 'uidMove').mockImplementationOnce(async (...args) => {
    const result = await move(...args)
    const archive = imap.folder('Filed mail')
    const target = [...archive.messages.entries()][0]
    if (!target) throw new Error('Missing moved message')
    const [uid, message] = target
    imap.expunge('Filed mail', uid)
    archive.messages.set(archive.nextUid++, message)
    return result
  })
  expect((await run({ kind: 'archive' }))?.messages?.[0]?.status).toBe('applied')
  expect(view()?.messages[0]).toMatchObject({ id: messageId, labelIds: ['a:ARCHIVE'] })
  expect(() => enqueue({ kind: 'undo' })).toThrow('IMAP server did not verify the moved UID')
  expect(imap.writes).toHaveLength(1)
  expect(imap.folder('Filed mail').messages.size).toBe(1)
})

it('refuses to undo a move into a replacement folder with changed UIDVALIDITY', async () => {
  const { imap, run, view } = await fixture()
  await run({ kind: 'label', labelId: 'a:folder:Project', value: true })
  await run({ kind: 'trash', value: true })
  imap.addFolder('Project').validity = 2n
  expect(await run({ kind: 'undo' })).toMatchObject({
    status: 'failed',
    error: 'Undo unavailable: the original IMAP folder changed',
  })
  expect(imap.folder('Project').messages.size).toBe(0)
  expect(view()?.messages[0]?.labelIds).toEqual(['a:TRASH'])
})

it.each([
  { sameValidity: true, acknowledged: false },
  { sameValidity: false, acknowledged: false },
  { sameValidity: true, acknowledged: true },
])(
  'retries an expunge that left the source present (same UIDVALIDITY: $sameValidity, acknowledged: $acknowledged)',
  async ({ sameValidity, acknowledged }) => {
    const { imap, uid, messageId, view, enqueue, queue, settle } = await fixture({
      capability: 'UIDPLUS',
    })
    const expunge = vi.spyOn(imap, 'uidExpunge').mockResolvedValueOnce(acknowledged)
    const id = enqueue({ kind: 'archive' })
    await queue.tick()
    expect(queue.lookup('owner', [id])[0]).toMatchObject({
      status: 'pending',
      error: 'Copied, original not removed',
    })
    expect(imap.folder('INBOX').messages.get(uid)?.flags.has('\\Deleted')).toBe(true)
    expect(view()?.messages[0]).toMatchObject({ id: messageId, labelIds: ['a:ARCHIVE', 'a:INBOX'] })
    if (!sameValidity) imap.folder('INBOX').validity++
    expect((await settle(id))?.status).toBe(sameValidity ? 'applied' : 'failed')
    expect(expunge.mock.calls).toEqual(sameValidity ? [[uid], [uid]] : [[uid]])
    expect(imap.writes.filter(({ command }) => command === 'UID COPY')).toHaveLength(1)
    expect(imap.folder('Filed mail').messages.size).toBe(1)
  },
)

it('undoes the last IMAP change after an explicit no-op unstar', async () => {
  const { imap, view, run } = await fixture()
  await run({ kind: 'archive' })
  expect(await run({ kind: 'star', value: false })).toMatchObject({
    status: 'applied',
    messages: [],
  })
  expect(view()?.messages[0]?.labelIds).toEqual(['a:ARCHIVE'])
  expect(await run({ kind: 'undo' })).toMatchObject({ status: 'applied' })
  expect(view()?.messages[0]).toMatchObject({ labelIds: ['a:INBOX'], unread: true })
  expect(imap.writes.map(({ command }) => command)).toEqual(['UID MOVE', 'UID MOVE'])

  await run({ kind: 'mute', value: true })
  await run({ kind: 'star', value: false })
  expect(await run({ kind: 'undo' })).toMatchObject({ status: 'applied' })
  expect(view()?.muted).toBe(false)
})

it('refuses to undo a mute touched by a newer owner client', async () => {
  const { queue, view, run, enqueue, threadId } = await fixture()
  await run({ kind: 'mute', value: true })
  const id = randomUUID()
  queue.submit('other-owner', [{ id, action: { kind: 'mute', value: true, threadId } }])
  await queue.tick()
  expect(queue.lookup('other-owner', [id])[0]?.status).toBe('applied')
  expect(() => enqueue({ kind: 'undo' })).toThrow('Mute has changed since this action')
  expect(view()?.muted).toBe(true)
})

it('uses the mailbox role to refuse a scoped CLI and an agent filing into a second Trash', async () => {
  const { db, imap, queue, queries, store, threadId } = await fixture({ secondaryTrash: true })
  const labelId = 'a:folder:Secondary%20Deleted'
  const action = { kind: 'label', labelId, value: true, threadId } as const
  const cli = issueToken(db, { kind: 'cli', name: 'Scoped CLI', scopes: ['organize'] })
  expect(() => queue.submit(cli.id, [{ id: randomUUID(), action }], false)).toThrow(
    'Only the owner can move mail to or from Trash',
  )
  const token = issueToken(db, {
    kind: 'agent',
    name: 'Agent',
    scopes: ['organize'],
    expiresAt: Date.now() + 60_000,
  })
  const agent = authenticate(db, token.secret)
  if (!agent) throw new Error('Missing agent principal')
  const server = buildMcpServer(agent, {
    db,
    store,
    queries,
    drafts: new Drafts(db, store, () => null),
    mutations: queue,
  })
  const [a, b] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: 'test', version: '0' })
  try {
    await Promise.all([server.connect(a), client.connect(b)])
    expect(
      await client.callTool({
        name: 'add_label',
        arguments: { thread_ids: [threadId], label_id: labelId },
      }),
    ).toMatchObject({
      isError: true,
      content: [{ text: 'Only the owner can move mail to or from Trash' }],
    })
  } finally {
    await Promise.all([client.close(), server.close()])
  }
  await queue.tick()
  expect(imap.writes).toEqual([])
})

it('rechecks the Trash role before dispatching a queued agent label change', async () => {
  const { db, imap, queue, threadId } = await fixture()
  const token = issueToken(db, {
    kind: 'agent',
    name: 'Agent',
    scopes: ['organize'],
    expiresAt: Date.now() + 60_000,
  })
  const agent = authenticate(db, token.secret)
  if (!agent) throw new Error('Missing agent principal')
  const action = organizeAsAgent(db, queue, agent, 'add_label', [
    { kind: 'label', labelId: 'a:folder:Project', value: true, threadId },
  ])
  expect(action.error).toBeNull()
  imap.folder('Project').specialUse = '\\Trash'
  await queue.tick()
  expect(queue.agentResults(action.id)[0]).toMatchObject({
    status: 'failed',
    error: 'Only the owner can move mail to or from Trash',
  })
  expect(imap.writes).toEqual([])
})

it('reconciles a move whose response is lost without replaying it or offering an inverse', async () => {
  const { db, imap, messageId, view, run } = await fixture()
  const move = imap.uidMove.bind(imap)
  vi.spyOn(imap, 'uidMove').mockImplementationOnce(async (...args) => {
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
