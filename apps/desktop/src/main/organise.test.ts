import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type MessageDetail, MutationResponse, type ThreadSummary } from '@amc/protocol'
import { describe, expect, it, vi } from 'vitest'
import { EngineClient, EngineError } from './engine'
import { OrganiseSync } from './organise'
import { Replica } from './replica'

const THREAD: ThreadSummary = {
  id: 'account:thread',
  accountId: 'account',
  subject: 'Synthetic thread',
  snippet: '',
  participants: [],
  messageCount: 2,
  unreadCount: 1,
  starred: false,
  inInbox: true,
  hasAttachments: false,
  labelIds: ['account:INBOX', 'account:UNREAD'],
  lastMessageAt: 2,
  snoozedUntil: null,
  muted: false,
}

function message(id: string, labelIds: string[]): MessageDetail {
  return {
    id: `account:${id}`,
    threadId: THREAD.id,
    accountId: THREAD.accountId,
    rfcMessageId: null,
    inReplyTo: null,
    from: null,
    to: [],
    cc: [],
    bcc: [],
    replyTo: [],
    subject: THREAD.subject,
    snippet: '',
    bodyText: '',
    hasHtml: false,
    sentAt: Number(id),
    unread: labelIds.includes('account:UNREAD'),
    starred: labelIds.includes('account:STARRED'),
    labelIds,
    listUnsubscribe: null,
    attachments: [],
  }
}

function seed(replica: Replica, kind: 'gmail' | 'imap' = 'gmail') {
  replica.put('account', {
    id: THREAD.accountId,
    kind,
    address: 'owner@example.com',
    displayName: null,
    status: 'ready',
    lastSyncAt: null,
    lastError: null,
    messageCount: 2,
    backfill: { phase: 'done', fetched: 2, estimatedTotal: 2 },
  })
  replica.put('thread', THREAD)
  replica.put('message', message('1', THREAD.labelIds))
  replica.put('message', message('2', []))
  replica.modseq = 10
}

const inbox = { view: { kind: 'inbox' }, accountId: null } as const

it('updates Bucket lists and counts from Thread sync changes', () => {
  const replica = new Replica(':memory:')
  try {
    seed(replica)
    const query = { view: { kind: 'bucket', bucket: 'Reply' }, accountId: null } as const
    expect(replica.threads(query)).toEqual([])
    const bucket = {
      bucket: 'Reply',
      reason: 'Needs a reply',
      setBy: 'triage',
      setAt: 100,
    } as const
    replica.apply([
      { entity: 'thread', id: THREAD.id, op: 'upsert', modseq: 11, data: { ...THREAD, bucket } },
    ])
    expect(replica.threads(query)).toMatchObject([{ id: THREAD.id, bucket }])
    expect(replica.counts(THREAD.accountId).buckets).toEqual({ Reply: 1 })
    expect(replica.counts('another-account').buckets).toEqual({})
    replica.apply([
      {
        entity: 'thread',
        id: THREAD.id,
        op: 'upsert',
        modseq: 12,
        data: { ...THREAD, bucket: null },
      },
    ])
    expect(replica.threads(query)).toEqual([])
    expect(replica.counts(null).buckets).toEqual({})
  } finally {
    replica.db.close()
  }
})

describe('desktop Organise outbox', () => {
  it('rejects Snooze and Unsnooze before changing the replica when disabled', () => {
    const replica = new Replica(':memory:')
    try {
      seed(replica)
      const engine = new EngineClient('http://example.invalid', 'synthetic-token')
      const sync = new OrganiseSync(replica.organise, engine, async () => {})
      for (const action of [
        { kind: 'snooze', threadId: THREAD.id, until: Date.now() + 1000 },
        { kind: 'unsnooze', threadId: THREAD.id },
      ]) {
        expect(() => sync.enqueue(action, false)).toThrow('Snooze is disabled on this Engine')
      }
      expect(replica.organise.unsent()).toBeNull()
      expect(replica.threads(inbox)).toHaveLength(1)
      expect(replica.thread(THREAD.id)?.thread.snoozedUntil).toBeNull()
    } finally {
      replica.db.close()
    }
  })

  it('queues IMAP flags and requires a special-use Archive folder', () => {
    const replica = new Replica(':memory:')
    try {
      seed(replica, 'imap')
      expect(() => replica.organise.enqueue({ kind: 'archive', threadId: THREAD.id })).toThrow(
        'This IMAP Account has no Archive folder',
      )
      expect(replica.organise.unsent()).toBeNull()
      replica.organise.enqueue({ kind: 'read', threadId: THREAD.id, value: true })
      expect(replica.organise.unsent()?.action.kind).toBe('read')
      expect(replica.thread(THREAD.id)?.thread.unreadCount).toBe(0)
      expect(replica.threads(inbox)).toHaveLength(1)
    } finally {
      replica.db.close()
    }
  })

  it('skips an acknowledged no-op IMAP flag when selecting the desktop Undo target', () => {
    const replica = new Replica(':memory:')
    try {
      seed(replica, 'imap')
      const mute = replica.organise.enqueue({ kind: 'mute', threadId: THREAD.id, value: true })
      const unstar = replica.organise.enqueue({ kind: 'star', threadId: THREAD.id, value: false })
      replica.organise.resolve(
        [mute, unstar].map((id) => ({
          id,
          threadId: THREAD.id,
          status: 'applied',
          modseq: 11,
          error: null,
          messages: [],
        })),
      )
      expect(replica.organise.errors()).toEqual([
        { id: unstar, message: 'No IMAP flags changed', quiet: true, updateOnly: true },
      ])
      expect(replica.organise.errors()).toEqual([])
      expect(() =>
        replica.organise.enqueue({ kind: 'undo', threadId: THREAD.id, mutationId: unstar }),
      ).toThrow('No IMAP flags changed')
      replica.organise.enqueue({ kind: 'undo', threadId: THREAD.id })
      expect(replica.organise.unsent()?.action).toMatchObject({ kind: 'undo', mutationId: mute })
    } finally {
      replica.db.close()
    }
  })

  it('keeps optimistic state after reopening and removes it only when the replica has the acknowledgment', () => {
    const dir = mkdtempSync(join(tmpdir(), 'amc-replica-'))
    const path = join(dir, 'replica.db')
    let replica = new Replica(path)
    try {
      seed(replica)
      const id = replica.organise.enqueue({ kind: 'archive', threadId: THREAD.id })
      expect(replica.threads(inbox)).toEqual([])
      expect(replica.baseThread(THREAD.id)?.thread.inInbox).toBe(true)
      replica.db.close()
      replica = new Replica(path)
      expect(replica.organise.unsent()?.id).toBe(id)
      expect(replica.threads(inbox)).toEqual([])
      replica.organise.resolve([
        { id, threadId: THREAD.id, status: 'pending', modseq: 20, error: null },
      ])
      expect(replica.threads(inbox)).toEqual([])
      replica.put('thread', { ...THREAD, inInbox: false, labelIds: ['account:UNREAD'] })
      replica.put('message', message('1', ['account:UNREAD']))
      replica.modseq = 20
      replica.organise.rebuild()
      expect(replica.threads(inbox)).toEqual([])
      const undo = replica.organise.enqueue({ kind: 'undo', mutationId: id, threadId: THREAD.id })
      expect(replica.organise.unsent()).toMatchObject({
        id: undo,
        action: { kind: 'undo', mutationId: id },
      })
      expect(replica.threads(inbox)).toHaveLength(1)
      expect(
        replica.thread(THREAD.id)?.messages.map((m) => m.labelIds.includes('account:INBOX')),
      ).toEqual([true, false])
    } finally {
      replica.db.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('announces a partial Archive after sync and queues Undo only for acknowledged labels', () => {
    const replica = new Replica(':memory:')
    try {
      seed(replica)
      replica.put('thread', { ...THREAD, messageCount: 4 })
      for (const id of ['1', '2', '3', '4']) replica.put('message', message(id, ['account:INBOX']))
      const id = replica.organise.enqueue({ kind: 'archive', threadId: THREAD.id })
      replica.organise.resolve(
        MutationResponse.parse({
          mutations: [
            {
              id,
              threadId: THREAD.id,
              status: 'partial',
              modseq: 20,
              error: 'Gmail refused the change (HTTP 403)',
              messages: ['1', '2', '3', '4'].map((messageId) => ({
                messageId: `account:${messageId}`,
                status: messageId === '4' ? 'failed' : 'applied',
                appliedLabels: messageId === '4' ? [] : ['account:INBOX'],
                supersededLabels: [],
                failedLabels: messageId === '4' ? ['account:INBOX'] : [],
              })),
            },
          ],
        }).mutations,
      )
      expect(replica.organise.errors()).toEqual([])
      for (const id of ['1', '2', '3']) replica.put('message', message(id, []))
      replica.modseq = 20
      replica.organise.rebuild()
      const action = { kind: 'undo', mutationId: id, threadId: THREAD.id } as const
      expect(replica.organise.errors()).toEqual([
        { id, message: "Archived 3 of 4. 1 couldn't be changed", undo: action },
      ])
      expect(replica.organise.errors()).toEqual([])
      const undo = replica.organise.enqueue(action)
      expect(replica.organise.unsent()).toMatchObject({ id: undo, action })
      const stored = replica.db.prepare('SELECT patch FROM organise_queue WHERE id = ?').get(undo)
      expect(JSON.parse(String(stored?.patch)).labels).toEqual({
        'account:1': { 'account:INBOX': true },
        'account:2': { 'account:INBOX': true },
        'account:3': { 'account:INBOX': true },
      })
    } finally {
      replica.db.close()
    }
  })

  it('accepts non-UUID superseded message IDs and notices once when Engine truth arrives', () => {
    const replica = new Replica(':memory:')
    try {
      seed(replica)
      const id = replica.organise.enqueue({ kind: 'archive', threadId: THREAD.id })
      const result = MutationResponse.parse({
        mutations: [
          {
            id,
            threadId: THREAD.id,
            status: 'applied',
            modseq: 20,
            error: null,
            superseded: ['account:1'],
          },
        ],
      })
      replica.organise.resolve(result.mutations)
      expect(replica.threads(inbox)).toEqual([])
      expect(replica.organise.errors()).toEqual([])
      replica.modseq = 20
      replica.organise.rebuild()
      expect(replica.threads(inbox)).toHaveLength(1)
      expect(replica.organise.errors()).toEqual([
        { id, message: 'Changed elsewhere, left as is', quiet: true },
      ])
      replica.organise.resolve(result.mutations)
      expect(replica.organise.errors()).toEqual([])
      expect(replica.db.prepare('SELECT superseded FROM organise_queue').get()).toEqual({
        superseded: '["account:1"]',
      })
    } finally {
      replica.db.close()
    }
  })

  it('skips a deleted Thread when choosing global Undo from the local queue', () => {
    const replica = new Replica(':memory:')
    try {
      seed(replica)
      const newer = { ...THREAD, id: 'account:newer', messageCount: 1 }
      replica.put('thread', newer)
      replica.put('message', { ...message('3', THREAD.labelIds), threadId: newer.id })
      const older = replica.organise.enqueue({ kind: 'archive', threadId: THREAD.id })
      replica.organise.enqueue({ kind: 'archive', threadId: newer.id })
      replica.apply([{ entity: 'thread', id: newer.id, op: 'delete', modseq: 11 }])

      const undo = replica.organise.enqueue({ kind: 'undo' })
      const row = replica.db.prepare('SELECT undo_of FROM organise_queue WHERE id = ?').get(undo)
      expect(row).toEqual({ undo_of: older })
    } finally {
      replica.db.close()
    }
  })

  it('preserves the projected Snooze and the provider marker when archiving and undoing offline', () => {
    const replica = new Replica(':memory:')
    try {
      seed(replica)
      replica.put('thread', {
        ...THREAD,
        inInbox: false,
        snoozedUntil: Date.now() + 60_000,
        labelIds: ['account:AMC/Snoozed'],
      })
      replica.put('message', message('1', ['account:AMC/Snoozed']))
      const archive = replica.organise.enqueue({ kind: 'archive', threadId: THREAD.id })
      const projected = () => replica.thread(THREAD.id)?.thread
      expect(projected()?.snoozedUntil).toBeGreaterThan(Date.now())
      expect(projected()?.labelIds).toContain('account:AMC/Snoozed')

      // Reopening an older outbox can restore a prepared patch that removed the marker.
      replica.db
        .prepare(
          `UPDATE organise_queue SET patch = json_set(patch, '$.labels."account:1"."account:AMC/Snoozed"', json('false')) WHERE id = ?`,
        )
        .run(archive)
      replica.organise.rebuild()
      expect(projected()?.labelIds).toContain('account:AMC/Snoozed')

      replica.organise.enqueue({ kind: 'undo', threadId: THREAD.id })
      expect(projected()?.snoozedUntil).toBeGreaterThan(Date.now())
      expect(projected()?.labelIds).toContain('account:AMC/Snoozed')
    } finally {
      replica.db.close()
    }
  })

  it.each([401, 403])('rolls back all optimistic changes and stops on HTTP %i', async (status) => {
    const replica = new Replica(':memory:')
    try {
      seed(replica)
      const engine = new EngineClient('http://example.invalid', 'synthetic-token')
      const request = vi
        .spyOn(engine, 'request')
        .mockRejectedValue(new EngineError(status, 'refused', 'Synthetic refusal'))
      const sync = new OrganiseSync(replica.organise, engine, async () => {})
      const pending = replica.organise.enqueue({ kind: 'read', value: true, threadId: THREAD.id })
      replica.organise.resolve([
        { id: pending, threadId: THREAD.id, status: 'pending', modseq: 20, error: null },
      ])
      replica.organise.enqueue({ kind: 'archive', threadId: THREAD.id })
      expect(replica.threads(inbox)).toEqual([])
      await sync.flush()
      expect(replica.threads(inbox)).toHaveLength(1)
      expect(replica.counts(null).inboxUnread).toBe(1)
      expect(replica.organise.unsent()).toBeNull()
      expect(replica.organise.pending()).toEqual([])
      expect(replica.organise.errors()).toEqual([
        { id: expect.any(String), message: expect.stringMatching(/pair|refused/i) },
      ])
      await sync.flush()
      expect(request).toHaveBeenCalledTimes(1)
    } finally {
      replica.db.close()
    }
  })

  it('clears a pending overlay when the Engine refuses a status poll', async () => {
    const replica = new Replica(':memory:')
    try {
      seed(replica)
      const engine = new EngineClient('http://example.invalid', 'synthetic-token')
      const request = vi
        .spyOn(engine, 'request')
        .mockRejectedValue(new EngineError(403, 'forbidden', 'Synthetic refusal'))
      const sync = new OrganiseSync(replica.organise, engine, async () => {})
      const id = replica.organise.enqueue({ kind: 'archive', threadId: THREAD.id })
      replica.organise.resolve([
        { id, threadId: THREAD.id, status: 'pending', modseq: 20, error: null },
      ])
      await sync.flush()
      await sync.flush()
      expect(request).toHaveBeenCalledTimes(1)
      expect(request.mock.calls[0]?.[0]).toBe('/v1/mutations/status')
      expect(replica.threads(inbox)).toHaveLength(1)
    } finally {
      replica.db.close()
    }
  })

  it('reveals the reconciled Gmail state and reports a refusal once', () => {
    const replica = new Replica(':memory:')
    try {
      seed(replica)
      const id = replica.organise.enqueue({ kind: 'read', value: true, threadId: THREAD.id })
      expect(replica.counts(null).inboxUnread).toBe(0)
      replica.organise.resolve([
        { id, threadId: THREAD.id, status: 'failed', modseq: 30, error: 'Gmail refused' },
      ])
      expect(replica.counts(null).inboxUnread).toBe(0)
      replica.modseq = 30
      replica.organise.rebuild()
      expect(replica.counts(null).inboxUnread).toBe(1)
      expect(replica.organise.errors()).toEqual([{ id, message: 'Gmail refused' }])
      expect(replica.organise.errors()).toEqual([])
    } finally {
      replica.db.close()
    }
  })
})

it('describes Trash that succeeded for both messages even when one marker cleanup failed', () => {
  const replica = new Replica(':memory:')
  try {
    seed(replica)
    const id = replica.organise.enqueue({ kind: 'trash', value: true, threadId: THREAD.id })
    replica.organise.resolve([
      {
        id,
        threadId: THREAD.id,
        status: 'partial',
        modseq: 20,
        error: 'Gmail refused (HTTP 403)',
        messages: [
          {
            messageId: 'account:1',
            status: 'applied',
            appliedLabels: ['account:TRASH'],
            supersededLabels: ['account:AMC/Snoozed'],
            failedLabels: [],
          },
          {
            messageId: 'account:2',
            status: 'failed',
            appliedLabels: ['account:TRASH'],
            supersededLabels: [],
            failedLabels: ['account:AMC/Snoozed'],
          },
        ],
      },
    ])
    expect(replica.organise.errors()).toEqual([])
    replica.modseq = 20
    replica.organise.rebuild()
    const [notice] = replica.organise.errors()
    expect(notice?.undo).toMatchObject({ kind: 'undo', mutationId: id })
    expect(notice?.message).toMatch(/^Changed 2 of 2[.]/)
  } finally {
    replica.db.close()
  }
})

it('reports an uncertain Trash without an Undo or a Changed elsewhere notice', () => {
  const replica = new Replica(':memory:')
  try {
    seed(replica)
    const id = replica.organise.enqueue({ kind: 'trash', value: true, threadId: THREAD.id })
    replica.organise.resolve(
      MutationResponse.parse({
        mutations: [
          {
            id,
            threadId: THREAD.id,
            status: 'failed',
            modseq: 10,
            error: 'A change to Trash may have been applied. Gmail refused the change (HTTP 403)',
            superseded: [],
            messages: [
              {
                messageId: 'account:1',
                status: 'uncertain',
                appliedLabels: [],
                uncertainLabels: ['account:TRASH'],
                supersededLabels: [],
                failedLabels: [],
              },
              {
                messageId: 'account:2',
                status: 'failed',
                appliedLabels: [],
                supersededLabels: [],
                failedLabels: ['account:TRASH'],
              },
            ],
          },
        ],
      }).mutations,
    )
    expect(replica.organise.errors()).toEqual([
      {
        id,
        message: 'A change to Trash may have been applied. Gmail refused the change (HTTP 403)',
      },
    ])
  } finally {
    replica.db.close()
  }
})
