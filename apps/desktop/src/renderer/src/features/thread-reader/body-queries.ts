import { messageTextQuery } from '@/data/thread-queries'
import { getAmc } from '@/lib/amc'
import type { ReplicaThreadMessage } from '../../../../shared/api'
import { forEngine } from '../mailbox/mailbox-queries'

export function initiallyOpen(message: ReplicaThreadMessage, index: number, count: number) {
  return message.unread || index === count - 1
}

export function readerTextQuery(engineUrl: string | null, message: ReplicaThreadMessage) {
  const query = messageTextQuery(getAmc(), message.id, message.bodyRevision)
  return forEngine(engineUrl, {
    ...query,
    key: JSON.stringify([message.accountId, query.key]),
  })
}

// Match the fields the Desktop replica uses to invalidate a stored HTML body.
export function htmlSourceKey(message: ReplicaThreadMessage) {
  return JSON.stringify([message.bodyRevision, message.hasHtml, message.attachments])
}

export function cachedHtmlQuery(engineUrl: string | null, message: ReplicaThreadMessage) {
  return forEngine(engineUrl, {
    key: JSON.stringify(['cached-html', message.accountId, message.id, htmlSourceKey(message)]),
    load: () => getAmc().cachedMessageHtml(message.id),
    retainDuringBootstrap: 'defer-reads',
  })
}
