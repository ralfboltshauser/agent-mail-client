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

function seed(replica: Replica) {
  replica.put('thread', THREAD)
  replica.put('message', message('1', THREAD.labelIds))
  replica.put('message', message('2', []))
  replica.modseq = 10
}

const inbox = { view: { kind: 'inbox' }, accountId: null } as const

describe('desktop Organise outbox', () => {
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

  it('does not project an expired Snooze when undoing Archive offline', () => {
    const replica = new Replica(':memory:')
    try {
      seed(replica)
      replica.put('thread', {
        ...THREAD,
        inInbox: false,
        snoozedUntil: 1,
        labelIds: ['account:AMC/Snoozed'],
      })
      replica.put('message', message('1', ['account:AMC/Snoozed']))
      replica.organise.enqueue({ kind: 'archive', threadId: THREAD.id })
      replica.organise.enqueue({ kind: 'undo', threadId: THREAD.id })
      const thread = replica.thread(THREAD.id)?.thread
      expect(thread?.snoozedUntil).toBeNull()
      expect(thread?.labelIds).not.toContain('account:AMC/Snoozed')
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

  it('reveals the synced compensation and reports a refusal once', () => {
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
