import type { InboxSender } from '@amc/protocol'
import type { AmcApi, SmartInboxApi } from '../../../../shared/api'
import { type Candidate, cardKey, type Preview, type ReviewAction } from './model'

export async function loadPreview(
  api: AmcApi,
  smart: SmartInboxApi,
  id: Candidate['id'],
  history: ReviewAction[],
  batch: string,
) {
  const omit =
    id.kind === 'sender'
      ? history
          .filter(
            (entry) =>
              entry.batch === batch &&
              cardKey(entry.card) === cardKey(id) &&
              ['organise', 'bucket', 'reply', 'filter'].includes(entry.decision.kind) &&
              ['pending', 'applied'].includes(entry.status) &&
              entry.undo?.status !== 'applied',
          )
          .map(({ threadId }) => threadId)
      : []
  const page = await smart.triageQueue({
    ...(id.kind === 'sender'
      ? { accountId: id.accountId, senderAddress: id.address }
      : { threadId: id.threadId }),
    limit: 1,
    ...(omit.length ? { omitThreads: JSON.stringify([...new Set(omit)].slice(-100)) } : {}),
  })
  if (!page.reviewLookup) throw new Error('Update the Engine to use desktop triage review.')
  const candidate = page.cards.find((item) => cardKey(item.id) === cardKey(id))
  if (!candidate) return null
  const detail = await api.thread(candidate.threadId)
  const message = detail?.messages.find(({ id }) => id === candidate.messageId)
  if (!detail || detail.thread.accountId !== candidate.accountId || !message) {
    throw new Error('This review card is waiting for the local mail replica. Retry after sync.')
  }
  const latest = detail.messages
    .filter((item) => !item.labelIds.includes(`${candidate.accountId}:DRAFT`))
    .at(-1)
  return {
    ...candidate,
    detail,
    sender: reviewSender(candidate, detail.thread.inboxSender),
    replyTargetId: latest && (latest.from?.address || latest.replyTo.length) ? latest.id : null,
  } satisfies Preview
}

export function reviewSender(card: Candidate, sender: InboxSender | undefined) {
  if (
    sender?.accountId !== card.accountId ||
    sender.messageId !== card.messageId ||
    sender.status === 'unresolved' ||
    (card.id.kind === 'sender' && sender.address !== card.id.address)
  )
    return null
  return sender
}
