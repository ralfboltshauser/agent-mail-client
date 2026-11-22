import { randomBytes, randomUUID } from 'node:crypto'
import { FILTERED_LABEL, type FilterReviewInput, type TriageBucketResult } from '@amc/protocol'
import { expect, it, vi } from 'vitest'
import { authenticate, issueToken } from '../../auth/tokens.ts'
import { BlobStore } from '../../blobs.ts'
import { Sealer } from '../../crypto.ts'
import { FakeGmail } from '../../providers/gmail/fake.ts'
import { fromGmail } from '../../providers/gmail/mapping.ts'
import { FakeImap } from '../../providers/imap/fake.ts'
import { SyncManager } from '../../sync/manager.ts'
import { silentLog, tempDir, testDb } from '../../test-support.ts'
import { Mutations } from '../mutations.ts'
import { MailQueries } from '../queries.ts'
import { decideSender, listSenders } from '../senders/actions.ts'
import { MailStore } from '../store.ts'
import { correctionExamples, filterCorrections, filterCounts } from './annotations.ts'
import { filterActions, listFiltered, reviewFilter, suggestFilter } from './filtering.ts'
import { threadInput } from './input.ts'
import { setModelBucket } from './model.ts'
import { triageQueue } from './queue.ts'

function owner(db: ReturnType<typeof testDb>) {
  const { secret } = issueToken(db, { kind: 'cli', scopes: ['admin'], name: 'Fixture owner' })
  const principal = authenticate(db, secret)
  if (!principal) throw new Error('Expected fixture owner token')
  return principal
}

async function settle(queue: Mutations) {
  for (let pass = 0; pass < 5; pass++) await queue.tick()
}

function fixture() {
  const db = testDb()
  db.exec(`
    INSERT INTO account (id, kind, address, credentials, created_at)
    VALUES ('a', 'gmail', 'owner@example.test', X'00', 0);
    INSERT INTO sender_scan (account_id, ready) VALUES ('a', 1);
  `)
  const store = new MailStore(db, new BlobStore(tempDir()))
  const gmail = new FakeGmail()
  const queue = new Mutations(store, () => gmail, silentLog)
  const principal = owner(db)
  const put = (id: string, opts: Parameters<FakeGmail['add']>[1] = {}, listId?: string) => {
    const mapped = fromGmail(
      gmail.add(id, {
        from: 'feed@example.test',
        subject: 'Routine catalogue',
        date: Date.now(),
        ...opts,
      }),
    )
    store.putMessage('a', [], {
      ...mapped,
      ...(listId ? { listId, listUnsubscribe: '<https://example.test/unsubscribe>' } : {}),
    })
    return `a:${mapped.providerThreadId}`
  }
  const review = (
    threadId: string,
    decision: FilterReviewInput['decision'] = 'filtered',
    reason?: string,
  ) =>
    reviewFilter(store, principal, {
      threadId,
      decision,
      reason,
      source: 'triage-key',
      clientActionId: randomUUID(),
      expectedRevision: threadInput(db, threadId)?.modseq ?? -1,
    })
  const suggest = (id: string, options: Partial<TriageBucketResult> = {}) =>
    suggestFilter(store, 'a', `a:t-${id}`, `a:${id}`, {
      inputRevision: threadInput(db, `a:t-${id}`)?.modseq ?? -1,
      confidence: 'high',
      attention: 'routine',
      version: 'fixture/1',
      ...options,
    })
  return {
    db,
    store,
    gmail,
    queue,
    principal,
    put,
    review,
    suggest,
    handlers: filterActions(store, () => {}),
  }
}

it('moves exact Inbox messages, keeps other Gmail Labels, and supersedes the durable annotation on Undo', async () => {
  const { db, queue, gmail, principal, put, review, handlers } = fixture()
  try {
    const id = put(
      'primary',
      { threadId: 'mixed', labels: ['INBOX', 'UNREAD', 'CATEGORY_PROMOTIONS', 'STARRED'] },
      'Fixture List <catalogue.example.test>',
    )
    put('already-archived', { threadId: 'mixed', labels: ['UNREAD'] })
    put('spam', { threadId: 'mixed', labels: ['SPAM'] })
    const action = review(id, 'filtered', 'Synthetic comment')
    expect(action).toMatchObject({ status: 'pending', ownerReason: 'Synthetic comment' })
    expect(correctionExamples(db, 'a')).toEqual([])
    await settle(queue)
    const label = gmail.labelList.find(({ name }) => name === FILTERED_LABEL)?.id
    expect(label).toBeDefined()
    expect(await gmail.getMessageLabels('primary')).toEqual([
      'UNREAD',
      'CATEGORY_PROMOTIONS',
      'STARRED',
      label,
    ])
    expect(await gmail.getMessageLabels('already-archived')).toEqual(['UNREAD'])
    expect(await gmail.getMessageLabels('spam')).toEqual(['SPAM'])
    expect(listFiltered(db, 'a', undefined, 50).threads.map((thread) => thread.id)).toEqual([id])
    expect(correctionExamples(db, 'a')).toMatchObject([
      { chosen: 'filtered', ownerReason: 'Synthetic comment' },
    ])
    const row = db.prepare('SELECT * FROM triage_annotation WHERE id = ?').get(action.actionId)
    expect(row).toMatchObject({
      source: 'triage-key',
      label: 'filtered',
      error_type: 'false-negative',
      sender_hash: expect.stringMatching(/^[a-f0-9]{64}$/),
      sender_domain: 'example.test',
      list_id: 'catalogue.example.test',
      has_list_unsubscribe: 1,
      provider_category: 'CATEGORY_PROMOTIONS',
    })
    const handler = handlers[action.kind]
    if (!handler) throw new Error('Expected filter action handler')
    expect((await handler.undo(principal, action.actionId)).undo?.status).toBe('pending')
    await settle(queue)
    expect((await handler.get(action.actionId)).undo?.status).toBe('applied')
    expect(await gmail.getMessageLabels('primary')).toContain('INBOX')
    expect(correctionExamples(db, 'a')).toEqual([])
    expect(filterCorrections(db, 'a', undefined, 50).corrections).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ source: 'triage-key', superseded: true }),
        expect.objectContaining({ source: 'undo' }),
      ]),
    )
  } finally {
    db.close()
  }
})

it('requires owner evidence and high routine confidence and excludes protected mail', async () => {
  const { db, queue, gmail, store, principal, put, review, suggest } = fixture()
  try {
    put('no-examples')
    suggest('no-examples')
    await settle(queue)
    expect(await gmail.getMessageLabels('no-examples')).toContain('INBOX')
    review(put('example'), 'filtered', 'Synthetic positive example')
    await settle(queue)
    const accepted = 'replied@another.example.test'
    decideSender(store, principal, {
      accountId: 'a',
      address: accepted,
      decision: 'accept',
      expectedRevision: 0,
      clientActionId: randomUUID(),
    })
    db.prepare("INSERT INTO sender_evidence VALUES ('a', ?, 'fixture-reply')").run(accepted)
    db.exec("INSERT INTO sender_evidence VALUES ('a', 'known@example.test', 'fixture')")
    const guarded = [
      {
        id: 'low',
        options: { confidence: 'low' as const },
        message: { from: 'known@example.test' },
      },
      { id: 'medium', options: { confidence: 'medium' as const } },
      { id: 'interrupt', options: { attention: 'interrupt' as const } },
      { id: 'security', options: { attention: 'security' as const } },
      { id: 'uncertain', options: { attention: undefined } },
      { id: 'protected', message: { subject: 'New sign-in' } },
      { id: 'replied', message: { from: accepted } },
      { id: 'important', message: { labels: ['INBOX', 'IMPORTANT'] } },
      { id: 'old', message: { date: Date.now() - 48 * 60 * 60_000 } },
    ]
    for (const { id, options, message } of guarded) {
      put(id, message)
      suggest(id, options)
    }
    const auto = put('auto')
    suggest('auto')
    await settle(queue)
    for (const { id } of guarded) expect(await gmail.getMessageLabels(id)).toContain('INBOX')
    expect(await gmail.getMessageLabels('auto')).not.toContain('INBOX')
    expect(triageQueue(db, { threadId: 'a:t-low', limit: 1 }).cards[0]?.suggestFilter).toBe(true)
    const restored = review(auto, 'not filtered', 'Synthetic correction')
    await settle(queue)
    expect(await gmail.getMessageLabels('auto')).toContain('INBOX')
    expect(filterCounts(db)).toEqual({ autoFiltered: 1, restored: 1 })
    expect(
      db
        .prepare(`
      SELECT n.source, n.error_type, p.label, p.confidence, p.version
      FROM triage_annotation n JOIN triage_prediction p ON p.id = n.prediction_id
      WHERE n.id = ? AND p.automatic_action_id IS NOT NULL
    `)
        .get(restored.actionId),
    ).toEqual({
      source: 'restore-from-filtered',
      error_type: 'false-positive',
      label: 'filtered',
      confidence: 'high',
      version: 'fixture/1',
    })
    expect(correctionExamples(db, 'a')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ chosen: 'not filtered', ownerReason: 'Synthetic correction' }),
      ]),
    )
  } finally {
    db.close()
  }
})

it('ranks older examples relevant to the listed batch and keeps sender reasons separate', async () => {
  const { db, store, queue, put, review, principal } = fixture()
  try {
    const older = put('older', { from: 'catalogue@example.test' }, '<fixture-list.example.test>')
    review(older, 'filtered', 'Matching older example')
    await settle(queue)
    review(put('newer', { from: 'other@example.net' }), 'filtered', 'Different newer example')
    await settle(queue)
    put('query', { from: 'catalogue@example.test' })
    put('sender-reason', { from: 'sender@example.net' })
    decideSender(store, principal, {
      accountId: 'a',
      address: 'sender@example.net',
      decision: 'block',
      reason: 'Synthetic sender-level comment',
      clientActionId: randomUUID(),
      expectedRevision: 0,
    })
    expect(listSenders(db, { limit: 50 }).rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ status: 'blocked', reason: 'Synthetic sender-level comment' }),
      ]),
    )
    expect(
      correctionExamples(db, 'a', ['a:query'])
        .filter(({ chosen }) => chosen === 'filtered')
        .map(({ ownerReason }) => ownerReason),
    ).toEqual(['Matching older example', 'Different newer example'])
    expect(correctionExamples(db, 'a', ['a:query'])).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          chosen: 'block sender',
          ownerReason: 'Synthetic sender-level comment',
        }),
      ]),
    )
  } finally {
    db.close()
  }
})

it('rejects filter proposals without an exact live triage lease and current input revision', () => {
  const { db, store, put } = fixture()
  try {
    const threadId = put('target')
    const { secret } = issueToken(db, {
      kind: 'agent',
      name: 'Fixture agent',
      accountId: 'a',
      scopes: ['read', 'organize'],
      expiresAt: Date.now() + 60_000,
    })
    const principal = authenticate(db, secret)
    if (!principal) throw new Error('Expected fixture Agent')
    expect(
      setModelBucket(
        store,
        principal,
        { threadId, bucket: null, reason: 'Synthetic' },
        {
          inputRevision: threadInput(db, threadId)?.modseq ?? -1,
          outcome: 'filtered',
          attention: 'routine',
          confidence: 'high',
        },
      ),
    ).toMatchObject({ updated: false })
    expect(db.prepare('SELECT 1 FROM triage_prediction').get()).toBeUndefined()
  } finally {
    db.close()
  }
})

it.each(['MOVE', 'UIDPLUS'] as const)(
  'filters and restores using exact IMAP %s and preserves unrelated deleted mail',
  async (capability) => {
    const db = testDb()
    const store = new MailStore(db, new BlobStore(tempDir()))
    const sealer = new Sealer(randomBytes(32))
    const imap = new FakeImap()
    imap.capabilities.set(capability, true)
    const uid = imap.add('INBOX', 'Message-ID: <target@example.test>')
    const unrelated = imap.add('INBOX', 'Message-ID: <unrelated@example.test>', 'Unrelated', [
      '\\Deleted',
    ])
    db.prepare(
      "INSERT INTO account (id, kind, address, credentials, created_at) VALUES ('a', 'imap', ?, ?, 0)",
    ).run('owner@example.test', sealer.seal({}))
    const sync = new SyncManager({
      db,
      store,
      sealer,
      log: silentLog,
      imapClient: () => imap.client,
      imapPollMs: 60_000,
      oauthClient: () => ({ clientId: '', clientSecret: '' }),
    })
    const queue = new Mutations(store, () => null, silentLog, {
      imap: (account, work) => sync.organiseImap(account, work),
    })
    sync.start()
    try {
      await vi.waitFor(() => expect(new MailQueries(db).account('a')?.status).toBe('ready'))
      const target = db
        .prepare(
          "SELECT thread_id FROM message WHERE trim(rfc_message_id, '<>') = 'target@example.test'",
        )
        .get()?.thread_id
      expect(target).toBeTruthy()
      const principal = owner(db)
      const decide = (decision: FilterReviewInput['decision']) =>
        reviewFilter(store, principal, {
          threadId: String(target),
          decision,
          clientActionId: randomUUID(),
          expectedRevision: threadInput(db, String(target))?.modseq ?? -1,
        })
      const filter = decide('filtered')
      await settle(queue)
      expect(await filterActions(store, () => {})[filter.kind]?.get(filter.actionId)).toMatchObject(
        { status: 'applied' },
      )
      expect(imap.folder('INBOX').messages.has(uid)).toBe(false)
      expect(imap.folder(FILTERED_LABEL).messages.size).toBe(1)
      const restore = decide('not filtered')
      await settle(queue)
      expect(
        await filterActions(store, () => {})[restore.kind]?.get(restore.actionId),
      ).toMatchObject({ status: 'applied' })
      expect(imap.folder(FILTERED_LABEL).messages.size).toBe(0)
      expect(imap.folder('INBOX').messages.size).toBe(2)
      expect(imap.folder('INBOX').messages.has(unrelated)).toBe(true)
      expect(imap.writes.some(({ command }) => command === 'EXPUNGE')).toBe(false)
    } finally {
      await Promise.all([sync.stop(), queue.stop()])
      db.close()
    }
  },
)
