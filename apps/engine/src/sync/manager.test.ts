import { EventEmitter, once } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BlobStore } from '../blobs.ts'
import { Sealer } from '../crypto.ts'
import { MailStore } from '../mail/store.ts'
import { FakeGmail } from '../providers/gmail/fake.ts'
import type { GmailPubSub } from '../providers/gmail/pubsub.ts'
import type { GmailApi, GmailHistoryList } from '../providers/gmail/types.ts'
import { silentLog, tempDir, testDb } from '../test-support.ts'
import { SyncManager } from './manager.ts'

const topic = 'projects/amc-mail-x097y3/topics/amc-gmail'

function setup(push = true) {
  const db = testDb()
  const sealer = new Sealer(Buffer.alloc(32, 1))
  const store = new MailStore(db, new BlobStore(tempDir()))
  const owner = new FakeGmail()
  const other = new FakeGmail()
  other.address = 'other@example.com'

  const events = new EventEmitter()
  type Batch = Awaited<ReturnType<GmailPubSub['pull']>>
  const pubSub = {
    topic,
    pull: vi
      .fn<GmailPubSub['pull']>()
      .mockImplementation(async (signal) => {
        const [batch] = (await once(events, 'pull', { signal })) as [Batch | Error]
        if (batch instanceof Error) throw batch
        return batch
      })
      .mockResolvedValueOnce([]),
    acknowledge: vi.fn<GmailPubSub['acknowledge']>().mockResolvedValue(undefined),
  }
  const gmailApis = [owner, other]
  const sync = new SyncManager({
    db,
    store,
    sealer,
    log: silentLog,
    oauthClient: () => ({ clientId: 'test', clientSecret: 'test' }),
    gmailApi: () => gmailApis.shift() ?? owner,
    gmailPubSub: push ? pubSub : undefined,
  })
  for (const [createdAt, gmail] of gmailApis.entries()) {
    const id = gmail === owner ? 'owner' : 'other'
    db.prepare(
      "INSERT INTO account (id, kind, address, credentials, created_at) VALUES (?, 'gmail', ?, ?, ?)",
    ).run(id, gmail.address, sealer.seal({ refreshToken: 'test', scope: 'test' }), createdAt)
  }
  return {
    owner,
    other,
    store,
    db,
    restartOwner: (replacement: FakeGmail) => {
      gmailApis.push(replacement)
      sync.startAccount('owner')
    },
    start: async () => {
      sync.start()
      await vi.advanceTimersByTimeAsync(250)
    },
    pubSub,
    deliver: (batch: Batch | Error) => events.emit('pull', batch),
    close: async () => {
      await sync.stop()
      db.close()
    },
  }
}

describe('Gmail Pub/Sub sync', () => {
  let fixture: ReturnType<typeof setup> | undefined

  beforeEach(() => vi.useFakeTimers())
  afterEach(async () => {
    await fixture?.close()
    fixture = undefined
    vi.useRealTimers()
  })

  it('starts a watch per Gmail account and renews both daily', async () => {
    fixture = setup()
    const ownerWatch = vi.spyOn(fixture.owner, 'watch')
    const otherWatch = vi.spyOn(fixture.other, 'watch')
    await fixture.start()
    expect(ownerWatch).toHaveBeenCalledExactlyOnceWith(topic, expect.any(AbortSignal))
    expect(otherWatch).toHaveBeenCalledExactlyOnceWith(topic, expect.any(AbortSignal))

    await vi.advanceTimersByTimeAsync(24 * 60 * 60_000 - 251)
    expect(ownerWatch).toHaveBeenCalledTimes(1)
    expect(otherWatch).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(ownerWatch).toHaveBeenCalledTimes(2)
    expect(otherWatch).toHaveBeenCalledTimes(2)
  })

  it('coalesces notifications into an incremental sync for the matching account', async () => {
    fixture = setup()
    const { owner, other, store, pubSub, deliver } = fixture
    const ownerHistory = vi.spyOn(owner, 'history')
    const otherHistory = vi.spyOn(other, 'history')
    await fixture.start()
    ownerHistory.mockClear()
    otherHistory.mockClear()

    owner.add('new', { subject: 'New mail', labels: ['INBOX'] })
    deliver([
      { ackId: '1', address: owner.address },
      { ackId: '2', address: owner.address },
    ])
    await vi.advanceTimersByTimeAsync(249)
    expect(ownerHistory).not.toHaveBeenCalled()
    deliver([{ ackId: '3', address: owner.address }, { ackId: '4' }])
    await vi.advanceTimersByTimeAsync(1)

    expect(ownerHistory).toHaveBeenCalledTimes(1)
    expect(otherHistory).not.toHaveBeenCalled()
    expect(store.hasMessage('owner', 'new')).toBe(true)
    expect(pubSub.acknowledge).toHaveBeenNthCalledWith(1, ['1', '2'], expect.any(AbortSignal))
    expect(pubSub.acknowledge).toHaveBeenNthCalledWith(2, ['3', '4'], expect.any(AbortSignal))
  })

  it('polls at 60 seconds with healthy push and returns to 15 seconds on pull failure', async () => {
    fixture = setup()
    const { owner, store, deliver } = fixture
    await fixture.start()
    owner.add('missed', { subject: 'Dropped notification' })
    await vi.advanceTimersByTimeAsync(60_000 - 251)
    expect(store.hasMessage('owner', 'missed')).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(store.hasMessage('owner', 'missed')).toBe(true)

    deliver(new Error('Pub/Sub unavailable'))
    await vi.advanceTimersByTimeAsync(0)
    owner.add('outage', { subject: 'Pub/Sub outage' })
    await vi.advanceTimersByTimeAsync(15_000)
    expect(store.hasMessage('owner', 'outage')).toBe(true)
  })

  it('polls after reauthorization while the old history request is still pending', async () => {
    fixture = setup(false)
    const { owner, store, db, restartOwner } = fixture
    const replacement = new FakeGmail()
    const replacementHistory = vi.spyOn(replacement, 'history')
    let finishHistory!: (page: GmailHistoryList) => void
    const pending = new Promise<GmailHistoryList>((resolve) => {
      finishHistory = resolve
    })
    const oldHistory = vi.spyOn<GmailApi, 'history'>(owner, 'history').mockReturnValueOnce(pending)
    try {
      await fixture.start()
      expect(oldHistory).toHaveBeenCalledTimes(1)

      restartOwner(replacement)
      const oldSignal = oldHistory.mock.calls[0]?.[3]
      expect(oldSignal?.aborted).toBe(true)
      await vi.advanceTimersByTimeAsync(5_000)
      await vi.advanceTimersByTimeAsync(15_000)
      expect(replacementHistory).toHaveBeenCalledTimes(2)

      replacement.add('new', { subject: 'New mail' })
      await vi.advanceTimersByTimeAsync(15_000)
      expect(store.hasMessage('owner', 'new')).toBe(true)

      const cursor = () => db.prepare("SELECT cursor FROM account WHERE id = 'owner'").get()
      const current = cursor()
      finishHistory({
        historyId: '999',
        history: [{ id: '999', messagesDeleted: [{ message: { id: 'new', threadId: 'new' } }] }],
      })
      await vi.advanceTimersByTimeAsync(0)
      expect(store.hasMessage('owner', 'new')).toBe(true)
      expect(cursor()).toEqual(current)
    } finally {
      finishHistory({ historyId: '999' })
    }
  })

  it.each([false, true])(
    'keeps 15-second polling when the watch is unavailable (push configured: %s)',
    async (push) => {
      fixture = setup(push)
      const watch = vi
        .spyOn(fixture.owner, 'watch')
        .mockRejectedValue(new Error('Watch unavailable'))
      await fixture.start()
      fixture.owner.add('new', { subject: 'New mail' })
      await vi.advanceTimersByTimeAsync(15_000 - 251)
      expect(fixture.store.hasMessage('owner', 'new')).toBe(false)
      await vi.advanceTimersByTimeAsync(1)
      expect(fixture.store.hasMessage('owner', 'new')).toBe(true)
      expect(watch).toHaveBeenCalledTimes(push ? 1 : 0)
    },
  )
})
