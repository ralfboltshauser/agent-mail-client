import { randomBytes, randomUUID } from 'node:crypto'
import { FILTERED_LABEL, type FilterReviewInput, type SubmitTriagePrediction } from '@amc/protocol'
import { afterEach, expect, it, vi } from 'vitest'
import { authenticate, issueToken } from '../../auth/tokens.ts'
import { BlobStore } from '../../blobs.ts'
import { Sealer } from '../../crypto.ts'
import { FakeGmail } from '../../providers/gmail/fake.ts'
import { GmailHttpError } from '../../providers/gmail/http.ts'
import { fromGmail } from '../../providers/gmail/mapping.ts'
import { FakeImap } from '../../providers/imap/fake.ts'
import { SyncManager } from '../../sync/manager.ts'
import { silentLog, tempDir, testDb } from '../../test-support.ts'
import { Mutations } from '../mutations.ts'
import { MailQueries } from '../queries.ts'
import { MailStore } from '../store.ts'
import { editOwnerReason, messageFeatures } from './annotations.ts'
import { readEffective } from './examples.ts'
import { filterActions, listFiltered, reviewFilter } from './filtering.ts'
import { threadInput } from './input.ts'
import { prepareContext, setModelBucket, submitPrediction } from './model.ts'
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
    decision: FilterReviewInput['decision'] = 'filter.filtered',
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
  const lease = () => {
    const name = `triage-${randomUUID()}`
    const expiresAt = Date.now() + 60_000
    const { secret } = issueToken(db, {
      kind: 'agent',
      name,
      accountId: 'a',
      scopes: ['read', 'organize'],
      expiresAt,
    })
    db.prepare('INSERT INTO triage_lease (slot, holder, expires_at) VALUES (1, ?, ?)').run(
      name,
      expiresAt,
    )
    const agent = authenticate(db, secret)
    if (!agent) throw new Error('Expected lease bearer')
    return agent
  }
  return {
    db,
    store,
    gmail,
    queue,
    principal,
    put,
    review,
    lease,
    handlers: filterActions(store, () => {}),
  }
}

afterEach(() => vi.unstubAllEnvs())

it('moves only exact Inbox messages, saves one private reason and appends per-message Undo', async () => {
  vi.stubEnv('AMC_PRIVATE_TRIAGE_REASONS', '1')
  const { db, store, queue, gmail, principal, put, handlers } = fixture()
  try {
    const threadId = put(
      'primary',
      { threadId: 'mixed', labels: ['INBOX', 'UNREAD', 'CATEGORY_PROMOTIONS', 'STARRED'] },
      'Fixture List <catalogue.example.test>',
    )
    put('companion', { threadId: 'mixed' })
    put('already-archived', { threadId: 'mixed', labels: ['UNREAD'] })
    put('spam', { threadId: 'mixed', labels: ['SPAM'] })
    const request = {
      threadId,
      expectedRevision: threadInput(db, threadId)?.modseq ?? -1,
      clientActionId: randomUUID(),
      decision: 'filter.filtered' as const,
      reason: 'Synthetic comment',
    }
    const action = reviewFilter(store, principal, request)
    expect(action).toMatchObject({ status: 'pending', ownerReason: 'Synthetic comment' })
    expect(action.acceptedTargets.sort()).toEqual(['a:companion', 'a:primary'])
    expect(reviewFilter(store, principal, request)).toEqual(reviewFilter(store, principal, request))
    expect(() => reviewFilter(store, principal, { ...request, reason: 'Changed' })).toThrow(
      /already used/,
    )
    const edit = {
      editId: randomUUID(),
      expectedReasonRevision: action.reasonRevision ?? null,
      reason: 'Synthetic revision',
    }
    const revision = editOwnerReason(db, action.actionId, edit)
    expect(editOwnerReason(db, action.actionId, edit)).toEqual(revision)
    expect(() => editOwnerReason(db, action.actionId, { ...edit, reason: null })).toThrow(
      /already used/,
    )
    expect(() => editOwnerReason(db, action.actionId, { ...edit, editId: randomUUID() })).toThrow(
      /changed/,
    )
    expect(db.prepare('SELECT count(*) AS n FROM triage_owner_reason').get()).toEqual({ n: 2 })
    const row = db
      .prepare('SELECT features_json FROM triage_event WHERE action_id = ? AND message_id = ?')
      .get(action.actionId, 'a:primary')
    expect(JSON.parse(String(row?.features_json))).toMatchObject({
      senderHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      senderKeyVersion: 1,
      domain: 'example.test',
      listId: 'catalogue.example.test',
      hasListUnsubscribe: true,
      category: 'CATEGORY_PROMOTIONS',
    })
    await settle(queue)
    const label = gmail.labelList.find(({ name }) => name === FILTERED_LABEL)?.id
    expect(await gmail.getMessageLabels('primary')).toEqual([
      'UNREAD',
      'CATEGORY_PROMOTIONS',
      'STARRED',
      label,
    ])
    expect(await gmail.getMessageLabels('already-archived')).toEqual(['UNREAD'])
    expect(await gmail.getMessageLabels('spam')).toEqual(['SPAM'])
    expect(listFiltered(db, 'a', undefined, 50).threads.map((thread) => thread.id)).toEqual([
      threadId,
    ])
    const handler = handlers[action.kind]
    if (!handler) throw new Error('Missing filter action handler')
    expect((await handler.undo(principal, action.actionId)).undo?.status).toBe('pending')
    await settle(queue)
    expect((await handler.get(action.actionId)).undo?.status).toBe('applied')
    expect(await gmail.getMessageLabels('primary')).toContain('INBOX')
    expect(
      db
        .prepare("SELECT count(*) AS n FROM triage_event WHERE kind = 'undo' AND action_id = ?")
        .get(action.actionId),
    ).toEqual({ n: 2 })
    expect(
      db
        .prepare("SELECT count(*) AS n FROM triage_event WHERE kind = 'decision' AND action_id = ?")
        .get(action.actionId),
    ).toEqual({ n: 2 })
  } finally {
    db.close()
  }
})

function prediction(context: ReturnType<typeof prepareContext>): SubmitTriagePrediction {
  const ref = context.refs[0]
  if (!ref) throw new Error('Missing prediction input')
  const { exampleIds: _, ...input } = ref
  return {
    receipt: context.receipt,
    runId: context.runId,
    input,
    producer: {
      harnessId: 'fixture',
      modelId: 'fixture-model',
      adapterVersion: '1',
      promptVersion: '1',
    },
    outputs: {
      bucket: {
        labelId: 'bucket.update',
        confidence: 'high',
        matchedRuleRevisionId: null,
        displayReason: 'Synthetic update',
      },
      filter: { labelId: 'filter.filtered', confidence: 'high', matchedRuleRevisionId: null },
      protection: 'billing',
    },
  }
}

it('suggests every Filter result without provider work and validates exact displayed references', async () => {
  const { db, store, queue, gmail, principal, put, lease } = fixture()
  try {
    const threadId = put('target', { subject: 'Synthetic invoice' })
    const agent = lease()
    const request = prediction(prepareContext(db, agent, 'a', [{ id: threadId }]))
    const result = submitPrediction(store, agent, request)
    expect(result).toMatchObject({
      outcomes: [{ projection: 'applied' }, { projection: 'suggested' }],
    })
    expect(submitPrediction(store, agent, request)).toEqual(result)
    expect(
      submitPrediction(store, agent, {
        ...request,
        outputs: { ...request.outputs, protection: 'routine' },
      }),
    ).toHaveProperty('error')
    await settle(queue)
    expect(await gmail.getMessageLabels('target')).toContain('INBOX')
    expect(db.prepare('SELECT 1 FROM screening_work').get()).toBeUndefined()
    const card = triageQueue(db, { threadId, limit: 1 }).cards[0]
    if (!card) throw new Error('Missing review card')
    expect(card.suggestFilter).toBe(true)
    expect(card.predictionId).toBeTruthy()
    const action = reviewFilter(store, principal, {
      threadId,
      predictionId: card.predictionId,
      expectedRevision: card.threadRevision,
      clientActionId: randomUUID(),
      decision: 'filter.filtered',
    })
    expect(
      db.prepare('SELECT prediction_id FROM triage_event WHERE action_id = ?').get(action.actionId),
    ).toEqual({ prediction_id: card.predictionId })
    await settle(queue)
    const restored = reviewFilter(store, principal, {
      threadId,
      expectedRevision: threadInput(db, threadId)?.modseq ?? -1,
      clientActionId: randomUUID(),
      decision: 'filter.keep',
    })
    await settle(queue)
    expect(await gmail.getMessageLabels('target')).toContain('INBOX')
    expect(
      db
        .prepare('SELECT prediction_id FROM triage_event WHERE action_id = ?')
        .get(restored.actionId),
    ).toEqual({ prediction_id: null })
  } finally {
    db.close()
  }
})

it('keeps stale predictions on the captured arrival and refuses revoked or tampered receipts', () => {
  const { db, store, put, lease } = fixture()
  try {
    const threadId = put('target', { threadId: 'raced', date: Date.now() - 1000 })
    const agent = lease()
    const request = prediction(prepareContext(db, agent, 'a', [{ id: threadId }]))
    expect(
      setModelBucket(
        store,
        agent,
        { threadId, bucket: null, reason: 'Legacy' },
        { inputRevision: request.input.inputRevision },
      ),
    ).toMatchObject({ updated: false })
    expect(
      submitPrediction(store, agent, { ...request, receipt: `${request.receipt}0` }),
    ).toHaveProperty('error')
    put('late', { threadId: 'raced' })
    expect(submitPrediction(store, agent, request)).toMatchObject({
      outcomes: [{ projection: 'stale' }, { projection: 'stale' }],
    })
    expect(db.prepare('SELECT DISTINCT arrival_key FROM triage_event').all()).toEqual([
      { arrival_key: 'a:target' },
    ])
    expect(
      triageQueue(db, { threadId, limit: 1 }).cards.some(({ suggestFilter }) => suggestFilter),
    ).toBe(false)
    const fresh = prediction(prepareContext(db, agent, 'a', [{ id: threadId }]))
    db.prepare('UPDATE token SET revoked_at = ? WHERE id = ?').run(Date.now(), agent.tokenId)
    expect(submitPrediction(store, agent, fresh)).toHaveProperty('error')
    expect(db.prepare('SELECT count(*) AS n FROM triage_event').get()).toEqual({ n: 2 })
  } finally {
    db.close()
  }
})

it('keeps private reasons off by default and learns eligible judgment despite provider failure', async () => {
  vi.stubEnv('AMC_PRIVATE_TRIAGE_REASONS', '0')
  const { db, put, review, queue, gmail, handlers } = fixture()
  try {
    const tid = put('sample')
    expect(() => review(tid, 'filter.filtered', 'Synthetic private reason')).toThrow(/disabled/)
    const action = review(tid)
    vi.spyOn(gmail, 'modifyMessage').mockRejectedValue(
      new GmailHttpError(403, 'forbidden', 'Synthetic provider rejection'),
    )
    await settle(queue)
    expect(await handlers[action.kind]?.get(action.actionId)).toMatchObject({
      status: expect.stringMatching(/failed|partial/),
    })
    put('candidate')
    const features = messageFeatures(db, 'a', 1, 'a:candidate')
    expect(readEffective(db, 'a', 1, { arrival: 'a:candidate', features })).toMatchObject([
      { labelId: 'filter.filtered' },
    ])
    expect(db.prepare('SELECT 1 FROM triage_owner_reason').get()).toBeUndefined()
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
      const filter = decide('filter.filtered')
      await settle(queue)
      expect(await filterActions(store, () => {})[filter.kind]?.get(filter.actionId)).toMatchObject(
        { status: 'applied' },
      )
      expect(imap.folder('INBOX').messages.has(uid)).toBe(false)
      expect(imap.folder(FILTERED_LABEL).messages.size).toBe(1)
      const restore = decide('filter.keep')
      await settle(queue)
      expect(
        await filterActions(store, () => {})[restore.kind]?.get(restore.actionId),
      ).toMatchObject({ status: 'applied' })
      expect(db.prepare('SELECT DISTINCT arrival_key FROM triage_event').all()).toHaveLength(1)
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
