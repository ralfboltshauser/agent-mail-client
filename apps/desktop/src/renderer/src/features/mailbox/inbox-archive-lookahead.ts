import { useEffect } from 'react'
import { replicaStoreFor } from '@/data/replica-store'
import type { ThreadIndex } from '@/data/thread-queries'
import { useReplicaSelector } from '@/hooks/use-amc'
import { getAmc } from '@/lib/amc'
import { cachedHtmlQuery, initiallyOpen, readerTextQuery } from '../thread-reader/body-queries'
import { type MailboxThreadQuery, selectedThreadQuery } from './mailbox-queries'

export function InboxArchiveLookahead({
  engineUrl,
  mailbox,
  selectedId,
  readIds,
}: {
  engineUrl: string | null
  mailbox: MailboxThreadQuery | null
  selectedId: string | null
  readIds: (index: ThreadIndex | undefined) => readonly string[] | undefined
}) {
  const candidate = useReplicaSelector(
    mailbox,
    ({ data }) => {
      const order = readIds(data)
      if (!data || !order || selectedId === null) return
      // Predict the same surviving neighbour that selection uses after observing removal.
      // With no successor, the last row advances to its predecessor.
      const index = order.indexOf(selectedId)
      const id = index === -1 ? order[0] : (order[index + 1] ?? order[index - 1])
      const candidate = id === undefined ? undefined : data.summaries.get(id)
      return candidate && { id: candidate.id, accountId: candidate.accountId }
    },
    (left, right) => left?.id === right?.id && left?.accountId === right?.accountId,
  )
  const id = candidate?.id
  const accountId = candidate?.accountId

  useEffect(() => {
    if (id === undefined || accountId === undefined) return
    const detail = selectedThreadQuery(engineUrl, { id, accountId })
    if (!detail) return
    const store = replicaStoreFor(getAmc())
    let releaseBody: (() => void) | undefined
    let bodyKey: string | object | undefined
    let disposed = false
    const prepareBody = () => {
      if (disposed) return
      const messages = store.getQuery(detail).data?.messages
      const firstOpen = messages?.find((item, index) => initiallyOpen(item, index, messages.length))
      const message =
        firstOpen?.accountId === accountId && firstOpen.threadId === id ? firstOpen : undefined
      const query = message?.hasHtml
        ? cachedHtmlQuery(engineUrl, message)
        : message && message.bodyText === null
          ? readerTextQuery(engineUrl, message)
          : null
      if (query?.key === bodyKey) return
      releaseBody?.()
      bodyKey = query?.key
      releaseBody = query ? store.subscribeQuery(query, () => {}) : undefined
    }
    const releaseDetail = store.subscribeQuery(detail, prepareBody)
    prepareBody()
    return () => {
      disposed = true
      // React cleans up passive subscriptions before mounting their replacements.
      // Keep the lease through that commit so the reader can adopt an in-flight read.
      void Promise.resolve().then(() => {
        releaseBody?.()
        releaseDetail()
      })
    }
  }, [engineUrl, id, accountId])

  return null
}
