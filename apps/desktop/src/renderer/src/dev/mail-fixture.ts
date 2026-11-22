import {
  type AccountSummary,
  actionLabels,
  applyLabelPatch,
  BUCKETS,
  type ComposeDraft,
  type OutboxItem,
  type ThreadSummary,
} from '@amc/protocol'
import type { AmcApi, ReplicaThreadMessage, SyncStatus, TriageStatus } from '../../../shared/api'

/** Synthetic data only. The fixture never calls the preload bridge. */
export function createFixture(scenario: string): AmcApi {
  const now = Date.now()
  const account: AccountSummary = {
    id: 'studio',
    kind: 'gmail',
    address: 'jules@example.test',
    displayName: 'Jules Rivera',
    status: 'ready',
    lastSyncAt: now,
    lastError: null,
    messageCount: 8,
    backfill: { phase: 'done', fetched: 8, estimatedTotal: 8 },
  }
  const self = { name: account.displayName, address: account.address }
  const sample = [
    ['Mina Park', 'Field Notes · print proof', 'Could you approve the warm grey before Thursday?'],
    ['Noah Ellis', 'Sunday at the studio', 'I booked the north room from 10 to 12.'],
    [
      'Tess Morgan',
      'Invoice for the spring issue',
      'The revised invoice includes the paper samples.',
    ],
    ['Ari Kaplan', 'A few reads for the train', 'Three really good pieces from this weekend.'],
    ['Sam Okafor', 'April launch checklist', 'I added the final photo credits this morning.'],
    ['Eli Chen', 'Workshop venue confirmed', 'They can hold the courtyard through Friday.'],
    ['Rue Bell', 'Notes from the type review', 'The captions are set at the new size.'],
    ['Sana Reed', 'Samples from the paper mill', 'Both swatch books arrived this morning.'],
  ] as const
  let threads: ThreadSummary[] =
    scenario === 'empty' || scenario === 'loading'
      ? []
      : sample.map(([name, subject, snippet], i) => ({
          id: `thread-${i + 1}`,
          accountId: account.id,
          subject,
          snippet,
          participants: [{ name, address: `${name.toLowerCase().replace(' ', '.')}@example.test` }],
          messageCount: i === 0 ? 2 : 1,
          unreadCount: i < 3 ? 1 : 0,
          starred: i === 0 || i === 4,
          inInbox: true,
          hasAttachments: i === 0 || i === 2,
          labelIds: i === 0 ? ['studio:editorial'] : [],
          lastMessageAt: now - 60_000 * (32 + i * i * 90),
          snoozedUntil: null,
          muted: false,
          bucket: {
            bucket: BUCKETS[i % BUCKETS.length] ?? 'Later',
            reason:
              i === 0 ? 'Mina needs your approval on the print proof before Thursday.' : snippet,
            setBy: 'Studio Agent',
            setAt: now,
          },
        }))
  const phase =
    scenario === 'pair-error'
      ? 'unpaired'
      : scenario === 'error'
        ? 'offline'
        : scenario === 'loading'
          ? 'bootstrapping'
          : 'live'
  const status: SyncStatus = {
    phase,
    engineUrl: 'https://engine.example.test',
    progress: scenario === 'loading' ? 0.38 : null,
    lastSyncAt: phase === 'live' ? now : null,
    error: scenario === 'error' ? 'The connection to the Engine timed out.' : null,
    snoozeEnabled: true,
    healthRefreshFailed: scenario === 'health-error',
  }
  const changed = new Set<() => void>()
  const mutations = new Map<string, ThreadSummary>()
  const notify = () =>
    changed.forEach((listener) => {
      listener()
    })
  let discarded = false
  let draft: ComposeDraft = {
    id: 'draft-1',
    accountId: account.id,
    threadId: null,
    from: self.address,
    to: [threads[0]?.participants[0] ?? self],
    cc: [],
    bcc: [],
    subject: 'Re: Spring workshop',
    body: 'Thursday works for me.',
    lastAuthor: 'Jules',
    updatedAt: now,
    attachments: [],
    revision: 1,
    update: 'AAA=', // Base64 encoding of an empty Yjs state update.
    quote: '',
    signature: '',
    mirrorError: false,
    mirrorConflict: false,
  }
  let outbox: OutboxItem[] = [
    {
      id: 'send-1',
      draftId: draft.id,
      accountId: account.id,
      messageId: 'message-1',
      subject: 'Studio visit on Thursday',
      to: draft.to,
      status: 'queued',
      sendAt: now + 86_400_000,
      undoUntil: now,
      detail: null,
      canResolve: false,
      threadId: null,
    },
  ]
  let undoSendSeconds = 10
  let notificationSettings = { enabled: true, showSnippet: true, quietStart: '', quietEnd: '' }
  const message = (thread: ThreadSummary, older: boolean): ReplicaThreadMessage => ({
    id: `${thread.id}:${older ? 'older' : 'latest'}`,
    threadId: thread.id,
    accountId: thread.accountId,
    rfcMessageId: null,
    inReplyTo: null,
    from: older ? self : (thread.participants[0] ?? self),
    to: older ? thread.participants : [self],
    cc: [],
    bcc: [],
    replyTo: [],
    subject: thread.subject,
    snippet: older ? 'Sending over the updated layout.' : thread.snippet,
    bodyText: older
      ? 'Sending over the updated layout.'
      : thread.id === 'thread-1'
        ? 'Hi Jules,\n\nThe printer sent the first proof for Field Notes. The photographs came through beautifully, and the new captions sit much better on the page.\n\nCould you approve the warm grey before Thursday? I’ve attached the proof so you can compare it with the sample we looked at on Monday.\n\nThanks,\nMina'
        : thread.snippet,
    hasHtml: false,
    sentAt: thread.lastMessageAt - (older ? 3_600_000 : 0),
    unread: !older && thread.unreadCount > 0,
    starred: thread.starred,
    labelIds: thread.labelIds,
    listUnsubscribe: null,
    bodyRevision: '1',
    attachments:
      !older && thread.hasAttachments
        ? [
            {
              id: 'proof',
              filename: 'Print proof.pdf',
              mimeType: 'application/pdf',
              size: 124_200,
              inline: false,
              contentId: null,
            },
          ]
        : [],
  })
  const filter = (query: string) =>
    threads.filter((thread) =>
      [thread.subject, thread.snippet, ...thread.participants.map((person) => person.name)]
        .join(' ')
        .toLowerCase()
        .includes(query.toLowerCase()),
    )
  let triage: TriageStatus = { enabled: true, running: false, lastRun: null, notice: null }
  const triageListeners = new Set<(status: TriageStatus) => void>()
  return {
    triageStatus: async () => triage,
    setAutoTriage: async (enabled) => {
      triage = { ...triage, enabled }
      for (const listener of triageListeners) listener(triage)
    },
    triageCounts: async () => ({ recent: 0, older: 3 }),
    triageNow: async () => {},
    onTriageStatus: (listener) => {
      triageListeners.add(listener)
      return () => {
        triageListeners.delete(listener)
      }
    },
    status: async () => status,
    onStatus: () => () => {},
    onOpenThread: () => () => {},
    onChanged: (listener) => {
      changed.add(listener)
      return () => {
        changed.delete(listener)
      }
    },
    pair: async () => {
      throw new Error('The pairing code has expired. Generate a new code on your Host.')
    },
    retrySavedPairing: async () => {},
    unpair: async () => {},
    syncNow: async () => {},
    accounts: async () => [account],
    labels: async () => [
      {
        id: 'studio:editorial',
        accountId: account.id,
        providerId: 'editorial',
        name: 'Editorial',
        kind: 'user',
        color: null,
      },
    ],
    counts: async () => ({
      inbox: threads.filter((thread) => thread.inInbox).length,
      inboxUnread: threads.filter((thread) => thread.inInbox && thread.unreadCount).length,
      starred: threads.filter((thread) => thread.starred).length,
      drafts: 1,
      buckets: Object.fromEntries(
        BUCKETS.map((bucket) => [
          bucket,
          threads.filter((thread) => thread.bucket?.bucket === bucket).length,
        ]),
      ),
    }),
    threads: async ({ view }) =>
      threads.filter((thread) => {
        const trashed = thread.labelIds.includes(`${account.id}:TRASH`)
        if (view.kind === 'trash') return trashed
        if (trashed) return false
        switch (view.kind) {
          case 'inbox':
            return thread.inInbox
          case 'unread':
            return thread.unreadCount > 0
          case 'snoozed':
            return thread.snoozedUntil !== null
          case 'starred':
            return thread.starred
          case 'bucket':
            return thread.bucket?.bucket === view.bucket
          case 'label':
            return thread.labelIds.includes(view.labelId)
          case 'all':
            return true
          default:
            return false
        }
      }),
    thread: async (id) => {
      const thread = threads.find((item) => item.id === id)
      if (!thread) return null
      return {
        thread,
        messages:
          thread.messageCount === 2
            ? [message(thread, true), message(thread, false)]
            : [message(thread, false)],
        drafts: [],
      }
    },
    summaries: async (ids) => threads.filter((thread) => ids.includes(thread.id)),
    filter: async (query) => filter(query),
    search: async (query) => {
      if (scenario === 'error') throw new Error('The Engine is offline.')
      return filter(query).map((thread) => ({ ...thread, matchSnippet: thread.snippet }))
    },
    setBucket: async ({ threadId, bucket, reason }) => {
      threads = threads.map((thread) =>
        thread.id === threadId
          ? {
              ...thread,
              bucket: bucket ? { bucket, reason, setBy: 'Jules', setAt: Date.now() } : null,
            }
          : thread,
      )
      notify()
    },
    organise: async (action) => {
      if (action.kind === 'undo') {
        const id = action.mutationId ?? [...mutations.keys()].at(-1)
        const previous = id ? mutations.get(id) : undefined
        if (!id || !previous) throw new Error('No synthetic action to undo.')
        threads = threads.map((thread) => (thread.id === previous.id ? previous : thread))
        mutations.delete(id)
        notify()
        return id
      }
      const thread = threads.find((item) => item.id === action.threadId)
      if (!thread) throw new Error('Synthetic thread not found.')
      const id = crypto.randomUUID()
      mutations.set(id, thread)
      const patch = actionLabels(action, account.id)
      let updated = thread
      switch (action.kind) {
        case 'archive':
          updated = { ...thread, inInbox: false }
          break
        case 'snooze':
          updated = { ...thread, inInbox: false, snoozedUntil: action.until }
          break
        case 'trash':
          updated = { ...thread, inInbox: !action.value }
          break
        case 'read':
          updated = { ...thread, unreadCount: action.value ? 0 : 1 }
          break
        case 'star':
          updated = { ...thread, starred: action.value }
          break
        case 'mute':
          updated = { ...thread, muted: action.value }
          break
      }
      const labelIds = applyLabelPatch(thread.labelIds, patch)
      threads = threads.map((item) => (item.id === thread.id ? { ...updated, labelIds } : item))
      notify()
      return id
    },
    organiseErrors: async () => [],
    agentActivity: async () => ({
      actions: [
        {
          id: 'activity-1',
          tokenName: 'Studio Agent',
          tool: 'set_bucket',
          threads: ['thread-1'],
          createdAt: now - 60_000,
          status: 'applied',
          error: null,
          draftId: null,
          mutations: [],
        },
      ],
      nextBefore: null,
    }),
    undoAgentAction: async () => {},
    contacts: async () => [],
    startCompose: async ({ mode, threadId }) => {
      discarded = false
      const thread = threads.find((item) => item.id === threadId)
      draft = {
        ...draft,
        threadId: threadId ?? null,
        subject: thread ? `${mode === 'forward' ? 'Fwd' : 'Re'}: ${thread.subject}` : '',
        to: thread && mode !== 'forward' ? thread.participants : [],
      }
      return draft
    },
    composeDrafts: async () => (discarded ? [] : [draft]),
    composeDraft: async () => draft,
    discardDraft: async (id) => {
      if (discarded) return { absent: id }
      discarded = true
      return { deleted: id }
    },
    stageComposeBody: () => {},
    saveCompose: async (_id, patch) => {
      draft = { ...draft, ...patch.fields, update: patch.update, revision: draft.revision + 1 }
      return draft
    },
    addComposeAttachment: async () => {
      throw new Error('Attachments are unavailable in the fixture.')
    },
    composeImage: async () => ({ content: '', mimeType: 'image/png' }),
    sendDraft: async ({ id, sendAt }) => {
      const item: OutboxItem = {
        ...(outbox[0] as OutboxItem),
        id,
        draftId: draft.id,
        accountId: account.id,
        messageId: 'message-2',
        to: draft.to,
        subject: draft.subject,
        status: 'queued',
        sendAt: sendAt ?? now,
        undoUntil: now,
        detail: null,
        canResolve: false,
        threadId: draft.threadId,
      }
      outbox = [item, ...outbox]
      notify()
      return item
    },
    outbox: async () => outbox,
    cancelSend: async (id) => {
      outbox = outbox.filter((item) => item.id !== id)
      notify()
    },
    resolveSend: async () => ({ draftId: draft.id }),
    signature: async () => ({ signature: draft.signature }),
    saveSignature: async (_id, signature) => {
      draft = { ...draft, signature }
      return { signature }
    },
    notificationSettings: async () => notificationSettings,
    saveNotificationSettings: async (settings) => {
      notificationSettings = settings
    },
    sendSettings: async () => ({ undoSendSeconds }),
    saveSendSettings: async (seconds) => {
      undoSendSeconds = seconds
      return { undoSendSeconds }
    },
    messageText: async () => null,
    messageHtml: async () => null,
    inlineAttachment: async () => '',
    openAttachment: async () => {},
    openExternal: async () => {},
    t3Setup: async () => ({ kind: 'mcp', address: '' }),
    t3Projects: async () => [],
    handoff: async () => {
      throw new Error('Hand off is unavailable in the fixture.')
    },
    cancelHandoff: async () => {},
    activeHandoff: async () => null,
    endHandoff: async () => {},
  }
}
