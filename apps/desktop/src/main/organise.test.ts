import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { MessageDetail, ThreadSummary } from '@amc/protocol'
import { describe, expect, it } from 'vitest'
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
