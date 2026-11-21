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

const MutationMessageResult = z.object({
  messageId: z.string().min(1),
  status: z.enum(['applied', 'superseded', 'failed', 'uncertain']),
  appliedLabels: z.array(z.string()),
  supersededLabels: z.array(z.string()),
  failedLabels: z.array(z.string()),
  uncertainLabels: z.array(z.string()).optional(),
})
export type MutationMessageResult = z.infer<typeof MutationMessageResult>

export const MutationResult = z.object({
  id,
  threadId: thread.shape.threadId,
  status: z.enum(['pending', 'applied', 'partial', 'failed']),
  error: z.string().nullable(),
  modseq: z.number().int().nonnegative(),
  messages: z.array(MutationMessageResult).optional(),
  // Message IDs whose Gmail labels changed independently during the mutation.
  superseded: z.array(z.string().min(1)).optional(),
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
      return system('TRASH', action.value)
    case 'read':
      return system('UNREAD', !action.value)
    case 'star':
      return system('STARRED', action.value)
    case 'label':
      return { [action.labelId]: action.value }
  }
}

/** IMAP folder actions replace the source folder membership. */
export function imapActionLabels(
  action: Exclude<OrganiseAction, { kind: 'undo' }>,
  accountId: string,
  folders: readonly string[],
): LabelPatch {
  const inbox = `${accountId}:INBOX`
  const trash = `${accountId}:TRASH`
  let destination: string
  switch (action.kind) {
    case 'mute':
    case 'snooze':
      return {}
    case 'archive':
      if (!folders.includes(inbox)) return {}
      destination = `${accountId}:ARCHIVE`
      break
    case 'trash':
      if (!action.value && !folders.includes(trash)) return {}
      destination = action.value ? trash : inbox
      break
    case 'label':
      if (!action.value) return {}
      destination = action.labelId
      break
    default:
      return actionLabels(action, accountId)
  }
  return Object.fromEntries([
    ...folders.filter((id) => id !== destination).map((id) => [id, false]),
    ...(!folders.includes(destination) ? [[destination, true]] : []),
  ])
}

export function imapActionError(
  action: OrganiseAction,
  accountId: string,
  folderIds: ReadonlySet<string>,
  moves: boolean | undefined = undefined,
): string | undefined {
  const has = (id: string) => folderIds.has(`${accountId}:${id}`)
  if (action.kind === 'archive' && !has('ARCHIVE')) return 'This IMAP Account has no Archive folder'
  if (action.kind === 'trash' && (!has('TRASH') || (!action.value && !has('INBOX'))))
    return 'This IMAP Account has no folder for this Trash action'
  if (action.kind === 'label' && !action.value)
    return 'Choose a destination folder to move IMAP mail'
  if (action.kind === 'snooze') return 'Snooze is unavailable for IMAP Accounts'
  if (moves === false && ['archive', 'trash', 'label'].includes(action.kind))
    return 'This IMAP server does not support safe moves'
}
