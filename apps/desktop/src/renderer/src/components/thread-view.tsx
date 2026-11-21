import { INLINE_IMAGE_TYPES } from '@amc/composer'
import { SNOOZED_LABEL, type ThreadMessage } from '@amc/protocol'
import { FileText, Paperclip, Star } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'
import { fileSize, fullDate, hueFor, initials, listDate, personName } from '@/lib/format'
import { cn } from '@/lib/utils'
import type { ThreadWithMessages } from '../../../shared/api'
import { HtmlBody, TextBody } from './message-body'

interface Props {
  data: ThreadWithMessages | null
  snoozeEnabled: boolean
  labelNames: Map<string, string>
  scrollRef: React.RefObject<HTMLDivElement | null>
}

const HIDDEN_LABELS = /:(INBOX|UNREAD|STARRED|IMPORTANT|SENT|DRAFT|CATEGORY_\w+)$/

export function ThreadView({ data, snoozeEnabled, labelNames, scrollRef }: Props) {
  if (!data) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-1 text-sm text-muted-foreground">
        <span>No Thread selected</span>
        <span className="text-xs">
          <kbd className="font-sans">J</kbd> / <kbd className="font-sans">K</kbd> to move ·{' '}
          <kbd className="font-sans">/</kbd> to search · <kbd className="font-sans">⌘K</kbd> for
          everything
        </span>
      </div>
    )
  }
  const { thread, messages } = data
  const snoozedUntil = snoozeEnabled ? thread.snoozedUntil : null
  const labels = thread.labelIds
    .filter((id) => !HIDDEN_LABELS.test(id) && id !== `${thread.accountId}:${SNOOZED_LABEL}`)
    .map((id) => labelNames.get(id) ?? id.split(':').pop() ?? id)

  return (
    <div ref={scrollRef} className="h-full overflow-y-auto">
      <div className="mx-auto max-w-3xl px-8 pt-4 pb-24">
        <div className="mb-5 flex items-start gap-3">
          <h1 className="flex-1 select-text text-xl font-semibold leading-snug tracking-tight">
            {thread.subject || '(no subject)'}
          </h1>
          {thread.starred && (
            <Star className="mt-1.5 size-4 shrink-0 fill-amber-400 text-amber-400" />
          )}
        </div>
        {(labels.length > 0 || thread.muted || snoozedUntil) && (
          <div className="-mt-3 mb-5 flex flex-wrap gap-1.5">
            {thread.muted && <Badge variant="secondary">Muted</Badge>}
            {snoozedUntil && (
              <Badge variant="secondary">Snoozed until {fullDate(snoozedUntil)}</Badge>
            )}
            {labels.map((l) => (
              <Badge key={l} variant="secondary" className="font-normal">
                {l}
              </Badge>
            ))}
          </div>
        )}
        <div className="space-y-3">
          <ThreadMessages key={thread.id} messages={messages} />
        </div>
      </div>
    </div>
  )
}

function ThreadMessages({ messages }: { messages: ThreadMessage[] }) {
  const rows = []
  for (let i = 0; i < messages.length; ) {
    const message = messages[i]
    if (!message) break
    if (message.bodyText !== null || message.unread || i === messages.length - 1) {
      rows.push(
        <Message
          key={message.id}
          message={message}
          defaultOpen={i === messages.length - 1 || message.unread}
        />,
      )
      i++
      continue
    }
    const start = i++
    while (i < messages.length - 1 && messages[i]?.bodyText === null && !messages[i]?.unread) i++
    rows.push(<OlderMessages key={message.id} messages={messages.slice(start, i)} />)
  }
  return rows
}

function OlderMessages({ messages }: { messages: ThreadMessage[] }) {
  const [shown, setShown] = useState(false)
  return (
    <div className="space-y-3">
      <button
        type="button"
        aria-expanded={shown}
        onClick={() => setShown(!shown)}
        className="w-full rounded-lg border bg-card px-4 py-3 text-left text-sm text-muted-foreground hover:bg-muted"
      >
        {messages.length} older {messages.length === 1 ? 'message' : 'messages'}
      </button>
      {shown &&
        messages.map((message) => (
          <Message key={message.id} message={message} defaultOpen={false} />
        ))}
    </div>
  )
}

function DeferredText({ id }: { id: string }) {
  const [body, setBody] = useState<string | null>()
  useEffect(() => {
    if (body !== undefined) return
    let cancelled = false
    window.amc.messageText(id).then(
      (text) => !cancelled && setBody(text),
      () => !cancelled && setBody(null),
    )
    return () => {
      cancelled = true
    }
  }, [id, body])
  if (body === undefined) return <Skeleton className="my-2 h-3 w-3/4" />
  if (body === null) {
    return (
      <button
        type="button"
        className="min-h-11 text-sm underline"
        onClick={() => setBody(undefined)}
      >
        Could not load message. Retry
      </button>
    )
  }
  return <TextBody text={body} />
}

function Message({ message: m, defaultOpen }: { message: ThreadMessage; defaultOpen: boolean }) {
  const [open, setOpen] = useState(defaultOpen)
  const [html, setHtml] = useState<string | null | undefined>(undefined)
  const isDraft = m.labelIds.some((l) => l.endsWith(':DRAFT'))
  const files = m.attachments.filter((a) => !a.inline)

  useEffect(() => {
    if (!open || !m.hasHtml || html !== undefined) return
    let cancelled = false
    window.amc
      .messageHtml(m.id)
      .then(async (h) => {
        if (!h || !/src=["']cid:/i.test(h)) {
          if (!cancelled) setHtml(h)
          return
        }
        const parts = m.attachments.filter(
          (a) =>
            a.inline &&
            a.contentId &&
            a.size <= 5 * 1024 * 1024 &&
            INLINE_IMAGE_TYPES.includes(a.mimeType) &&
            h.includes(`cid:${a.contentId}`),
        )
        const embedded = new Map(
          await Promise.all(
            parts.map(async (part) => {
              const content = await window.amc.inlineAttachment(part.id).catch(() => '')
              return [
                part.contentId,
                content ? `data:${part.mimeType};base64,${content}` : '',
              ] as const
            }),
          ),
        )
        if (!cancelled)
          setHtml(
            h.replace(/(\bsrc=["'])cid:([^"']+)/gi, (original, prefix, id) => {
              const data = embedded.get(id)
              return data ? prefix + data : original
            }),
          )
      })
      .catch(() => !cancelled && setHtml(null))
    return () => {
      cancelled = true
    }
  }, [open, m.hasHtml, m.id, m.attachments, html])

  const hue = hueFor(m.from?.address ?? '')
  const ref = useRef<HTMLDivElement>(null)

  return (
    <div
      ref={ref}
      className={cn('rounded-lg border bg-card', isDraft && 'border-dashed border-primary/50')}
    >
      <button
        type="button"
        className="flex w-full items-start gap-3 px-4 py-3 text-left"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <div
          className="flex size-8 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold"
          style={{ background: `oklch(0.9 0.05 ${hue})`, color: `oklch(0.35 0.08 ${hue})` }}
        >
          {initials(m.from)}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2">
            <span className="truncate text-[13px] font-semibold">{personName(m.from)}</span>
            {isDraft && <Badge className="h-4 px-1.5 text-[10px]">Draft</Badge>}
            {open && m.from && (
              <span className="truncate text-xs text-muted-foreground">{m.from.address}</span>
            )}
            <span
              className="ml-auto shrink-0 text-xs text-muted-foreground tabular-nums"
              title={fullDate(m.sentAt)}
            >
              {open ? fullDate(m.sentAt) : listDate(m.sentAt)}
            </span>
          </div>
          {open ? (
            <div className="truncate text-xs text-muted-foreground">
              to{' '}
              {[...m.to, ...m.cc].map((a) => personName(a)).join(', ') || 'undisclosed recipients'}
            </div>
          ) : (
            <div className="truncate text-[13px] text-muted-foreground">{m.snippet}</div>
          )}
        </div>
      </button>
      {open && (
        <div className="px-4 pb-4">
          {m.hasHtml && html === undefined ? (
            <div className="space-y-2 py-2">
              <Skeleton className="h-3 w-3/4" />
              <Skeleton className="h-3 w-2/3" />
              <Skeleton className="h-3 w-1/2" />
            </div>
          ) : m.hasHtml && html ? (
            <HtmlBody html={html} />
          ) : m.bodyText !== null ? (
            <TextBody text={m.bodyText} />
          ) : (
            <DeferredText id={m.id} />
          )}
          {m.bodySearchTruncated && (
            <p className="mt-2 text-xs text-muted-foreground">
              Search indexes only the start of this message.
            </p>
          )}
          {files.length > 0 && (
            <div className="mt-4 flex flex-wrap gap-2">
              {files.map((a) => (
                <button
                  key={a.id}
                  type="button"
                  onClick={() => void window.amc.openAttachment(a.id, a.filename)}
                  className="flex max-w-64 items-center gap-2 rounded-md border bg-background px-2.5 py-1.5 text-left text-xs hover:bg-muted"
                >
                  {a.mimeType.startsWith('image/') ? (
                    <Paperclip className="size-3.5 shrink-0" />
                  ) : (
                    <FileText className="size-3.5 shrink-0" />
                  )}
                  <span className="truncate">{a.filename || 'attachment'}</span>
                  <span className="shrink-0 text-muted-foreground">{fileSize(a.size)}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
