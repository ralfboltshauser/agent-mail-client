import type { AgentAction, AgentMutationResult, MutationResult } from '@amc/protocol'

export const activityRunId = '43f45d6e-219a-42b3-9c11-0bfb57617e71'
export const removedThreadId = 'studio:thread-removed-from-the-local-replica'

export function createActivityFixture(now: number) {
  const minute = 60_000
  const today = new Date(now).setHours(9, 42, 0, 0)
  const yesterday = new Date(today)
  yesterday.setDate(yesterday.getDate() - 1)
  const earlier = new Date(today)
  earlier.setDate(earlier.getDate() - 2)

  const mutation = (
    threadId: string,
    status: AgentMutationResult['status'],
    error: string | null = null,
  ): AgentMutationResult => ({
    id: `mutation-${threadId}`,
    threadId,
    status,
    error,
    modseq: 1,
    messages: [],
    undo: null,
  })

  const undoResult = (threadId: string): MutationResult => ({
    id: `undo-${threadId}`,
    threadId,
    status: 'applied',
    error: null,
    modseq: 2,
  })

  const action = (entry: Partial<AgentAction> & Pick<AgentAction, 'id' | 'tool'>): AgentAction => ({
    tokenName: 'Studio Agent',
    threads: [],
    createdAt: today,
    status: 'applied',
    error: null,
    draftId: null,
    mutations: [],
    ...entry,
  })

  const newest: AgentAction[] = [
    action({
      id: 'activity-bucket',
      tool: 'set_bucket',
      tokenName: `triage-${activityRunId}`,
      threads: ['thread-1'],
    }),
    action({
      id: 'activity-archive',
      tool: 'archive',
      threads: ['thread-2', removedThreadId, 'thread-4'],
      createdAt: today - 4 * minute,
      status: 'partial',
      mutations: [
        mutation('thread-2', 'applied'),
        mutation(removedThreadId, 'failed', 'Thread is no longer available'),
        mutation('thread-4', 'applied'),
      ],
    }),
    action({
      id: 'activity-draft',
      tool: 'update_draft',
      threads: ['thread-3'],
      createdAt: today - 12 * minute,
      draftId: 'draft-spring-issue',
      currentDraftMirrorFailed: true,
    }),
    action({
      id: 'activity-read',
      tool: 'mark_read',
      threads: ['thread-5'],
      status: 'pending',
      createdAt: today - 17 * minute,
      mutations: [mutation('thread-5', 'pending')],
    }),
    action({
      id: 'activity-rejected',
      tool: 'set_bucket',
      tokenName: `triage-${activityRunId}`,
      threads: [removedThreadId],
      status: 'rejected',
      error: 'Thread already has a Bucket or left the Inbox',
      createdAt: Number(yesterday),
    }),
    action({
      id: 'activity-label',
      tool: 'add_label',
      threads: ['thread-6'],
      status: 'failed',
      createdAt: Number(yesterday) - 32 * minute,
      mutations: [mutation('thread-6', 'failed', 'The Account rejected the Label change')],
    }),
    action({
      id: 'activity-star',
      tool: 'star',
      threads: ['thread-7'],
      createdAt: Number(yesterday) - 50 * minute,
      mutations: [
        {
          ...mutation('thread-7', 'applied'),
          undo: { ...undoResult('thread-7'), superseded: ['fixture-message'] },
        },
      ],
    }),
  ]
  const older = [
    action({
      id: 'activity-new-draft',
      tool: 'create_draft',
      draftId: 'draft-standalone',
      createdAt: Number(earlier),
    }),
  ]

  return {
    async agentActivity(before?: number) {
      return {
        actions: structuredClone(before === undefined ? newest : older),
        nextBefore: before === undefined ? 8 : null,
      }
    },
    async undoAgentAction(id: string) {
      const entry = newest.find((item) => item.id === id)
      if (!entry) throw new Error('Unknown fixture action')
      entry.mutations = entry.mutations.map((item) =>
        item.status === 'applied' && !item.undo
          ? { ...item, undo: undoResult(item.threadId) }
          : item,
      )
    },
  }
}
