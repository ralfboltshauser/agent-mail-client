import { z } from 'zod'

const thread = z.object({ threadId: z.string().min(1).max(512) })
const id = z.string().uuid()
export const SNOOZED_LABEL = 'AMC/Snoozed'

export const OrganiseAction = z.discriminatedUnion('kind', [
  thread.extend({ kind: z.literal('archive') }),
  thread.extend({ kind: z.literal('trash'), value: z.boolean() }),
  thread.extend({ kind: z.literal('read'), value: z.boolean() }),
  thread.extend({ kind: z.literal('star'), value: z.boolean() }),
  thread.extend({
    kind: z.literal('label'),
    labelId: z.string().min(1).max(512),
    value: z.boolean(),
  }),
  thread.extend({
    kind: z.literal('snooze'),
    until: z.number().int().positive().max(8.64e15),
    noReply: z.boolean().optional(),
  }),
  thread.extend({ kind: z.literal('mute'), value: z.boolean() }),
  z.object({
    kind: z.literal('undo'),
    threadId: thread.shape.threadId.optional(),
    mutationId: id.optional(),
  }),
])
export type OrganiseAction = z.infer<typeof OrganiseAction>

export const MutationRequest = z.object({ id, action: OrganiseAction })
export type MutationRequest = z.infer<typeof MutationRequest>

export const MutationBatch = z.object({ mutations: z.array(MutationRequest).min(1).max(100) })
export const MutationLookup = z.object({ ids: z.array(id).min(1).max(100) })

export const MutationResult = z.object({
  id,
  threadId: thread.shape.threadId,
  status: z.enum(['pending', 'applied', 'failed']),
  error: z.string().nullable(),
  modseq: z.number().int().nonnegative(),
})
export type MutationResult = z.infer<typeof MutationResult>

export const MutationResponse = z.object({ mutations: z.array(MutationResult) })
export type MutationResponse = z.infer<typeof MutationResponse>

/** Set membership is absolute so an operation can be retried or replayed over fresh data. */
export type LabelPatch = Record<string, boolean>

export function applyLabelPatch(labels: readonly string[], patch: LabelPatch): string[] {
  const result = new Set(labels)
  for (const [id, present] of Object.entries(patch)) {
    if (present) result.add(id)
    else result.delete(id)
  }
  return [...result].sort()
}

export function actionLabels(
  action: Exclude<OrganiseAction, { kind: 'undo' }>,
  accountId: string,
): LabelPatch {
  const system = (label: string, value: boolean) => ({ [`${accountId}:${label}`]: value })
  switch (action.kind) {
    case 'archive':
    case 'snooze':
      return system('INBOX', false)
    case 'mute':
      return action.value ? system('INBOX', false) : {}
    case 'trash':
      return { ...system('TRASH', action.value), ...(action.value ? system('INBOX', false) : {}) }
    case 'read':
      return system('UNREAD', !action.value)
    case 'star':
      return system('STARRED', action.value)
    case 'label':
      return { [action.labelId]: action.value }
  }
}
