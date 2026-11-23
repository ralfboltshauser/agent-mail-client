import { INLINE_IMAGE_TYPES } from '@amc/composer'
import type { AttachmentSummary } from '@amc/protocol'
import { useEffect, useEffectEvent, useMemo, useRef, useState } from 'react'
import { HtmlBody, MIN_HTML_BODY_HEIGHT, TextBody } from '@/components/message-body'
import { Skeleton } from '@/components/ui/skeleton'
import { senderPreferenceKey } from '@/data/remote-image-preferences'
import { replicaStoreFor } from '@/data/replica-store'
import { useReplicaState, useSyncField } from '@/hooks/use-amc'
import { getAmc } from '@/lib/amc'
import { recordCaughtFailure } from '@/lib/failure'
import type { ReplicaThreadMessage } from '../../../../shared/api'
import { cachedHtmlQuery, readerTextQuery } from './body-queries'

function useBodyRequest(
  key: object | null,
  load: () => Promise<string | null>,
  enabled: boolean,
  supplied: string | null = null,
) {
  const [result, setResult] = useState(() => ({ key: null as object | null, value: supplied }))
  const pending = useRef(new Map<object, Promise<string | null>>())
  const start = useEffectEvent(load)

  if (supplied !== null && (result.key !== key || result.value !== supplied)) {
    setResult({ key, value: supplied })
  }
  const settled = key !== null && result.key === key

  // Biome 2.2 predates Effect Events, whose identities change every render.
  // biome-ignore lint/correctness/useExhaustiveDependencies: The request key describes the loader inputs.
  useEffect(() => {
    if (key === null || settled || !enabled) return

    let request = pending.current.get(key)
    if (!request) {
      const requests = pending.current
      request = start()
      requests.set(key, request)
      const remove = () => requests.delete(key)
      void request.then(remove, remove)
    }
    let active = true
    void request.then(
      (value) => {
        if (active) setResult({ key, value })
      },
      () => {
        if (active) setResult({ key, value: null })
      },
    )
    return () => {
      active = false
    }
  }, [key, settled, enabled])

  return {
    value: result.value,
    settled,
    hasResult: result.key !== null,
  }
}

function inlineImages(attachments: AttachmentSummary[]) {
  return attachments.filter(
    (part) =>
      part.inline &&
      part.contentId &&
      part.size <= 5 * 1024 * 1024 &&
      INLINE_IMAGE_TYPES.includes(part.mimeType),
  )
}

async function embedInlineImages(html: string | null, parts: AttachmentSummary[]) {
  const api = getAmc()
  if (!html || !/src=["']cid:/i.test(html)) return html

  const embedded = new Map(
    await Promise.all(
      parts
        .filter((part) => html.includes(`cid:${part.contentId}`))
        .map(async (part) => {
          const content = await api.inlineAttachment(part.id).catch((error: unknown) => {
            recordCaughtFailure(error)
            return ''
          })
          return [part.contentId, content ? `data:${part.mimeType};base64,${content}` : ''] as const
        }),
    ),
  )
  return html.replace(/(\bsrc=["'])cid:([^"']+)/gi, (original, prefix, contentId) => {
    const data = embedded.get(contentId)
    return data ? prefix + data : original
  })
}

export function MessageContent({ message }: { message: ReplicaThreadMessage }) {
  const { id, bodyText, bodyRevision, hasHtml } = message
  const engineUrl = useSyncField((status) => status?.engineUrl ?? null)
  const parts = hasHtml ? inlineImages(message.attachments) : []
  const localHtml = hasHtml ? cachedHtmlQuery(engineUrl, message) : null
  // Join the speculative read only when there is one to adopt. Other messages can
  // use the normal HTML read, which checks SQLite before asking the Engine.
  const [preparedHtmlKey] = useState(() =>
    localHtml && replicaStoreFor(getAmc()).isQueryActive(localHtml) ? localHtml.key : null,
  )
  const preparedHtml = localHtml?.key === preparedHtmlKey ? localHtml : null
  const { snapshot: cachedHtml } = useReplicaState(preparedHtml)
  const rawHtml = cachedHtml.data ?? null
  const readyHtml = rawHtml && (!parts.length || !/src=["']cid:/i.test(rawHtml)) ? rawHtml : null
  const partKey = JSON.stringify(parts.map((part) => [part.id, part.contentId, part.mimeType]))
  const htmlKey = useMemo(
    () => (hasHtml ? { id, bodyRevision, partKey, rawHtml } : null),
    [hasHtml, id, bodyRevision, partKey, rawHtml],
  )
  const html = useBodyRequest(
    htmlKey,
    async () => embedInlineImages(rawHtml ?? (await getAmc().messageHtml(id)), parts),
    hasHtml && (!preparedHtml || cachedHtml.state !== 'first-load') && readyHtml === null,
    readyHtml,
  )
  const needsText = bodyText === null && (!hasHtml || (html.settled && !html.value))
  const { snapshot: deferred, refresh } = useReplicaState(
    needsText ? readerTextQuery(engineUrl, message) : null,
  )
  const text = bodyText ?? deferred.data
  const settled = deferred.state === 'first-error' || deferred.state === 'empty-success'
  const [lastText, setLastText] = useState<string | null>(null)
  if (text !== undefined && text !== lastText) setLastText(text)
  const visibleText = text === undefined && !settled ? lastText : text
  const [reserveTextSpace] = useState(bodyText === null)

  if (hasHtml && html.value) {
    const senderKey = senderPreferenceKey(message.accountId, message.from?.address ?? null)
    return <HtmlBody html={html.value} senderKey={senderKey} />
  }
  if (visibleText != null && (!hasHtml || html.hasResult)) {
    return (
      <div className={reserveTextSpace ? 'min-h-11' : undefined}>
        <TextBody text={visibleText} />
      </div>
    )
  }
  if (settled) {
    return (
      <button type="button" className="min-h-11 text-sm underline" onClick={refresh}>
        Could not load message. Retry
      </button>
    )
  }

  return (
    <div
      className={hasHtml ? 'space-y-2 py-2' : 'min-h-11 py-2'}
      style={hasHtml ? { minHeight: MIN_HTML_BODY_HEIGHT } : undefined}
      aria-busy="true"
    >
      <Skeleton className="h-3 w-3/4" />
      {hasHtml && (
        <>
          <Skeleton className="h-3 w-2/3" />
          <Skeleton className="h-3 w-1/2" />
        </>
      )}
    </div>
  )
}
