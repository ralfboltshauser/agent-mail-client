import { type MessageDetail, SNOOZED_LABEL } from '@amc/protocol'
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
  labelNames: Map<string, string>
  scrollRef: React.RefObject<HTMLDivElement | null>
}

const HIDDEN_LABELS = /:(INBOX|UNREAD|STARRED|IMPORTANT|SENT|DRAFT|CATEGORY_\w+)$/

export function ThreadView({ data, labelNames, scrollRef }: Props) {
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
        {(labels.length > 0 || thread.muted || thread.snoozedUntil) && (
          <div className="-mt-3 mb-5 flex flex-wrap gap-1.5">
            {thread.muted && <Badge variant="secondary">Muted</Badge>}
            {thread.snoozedUntil && (
              <Badge variant="secondary">Snoozed until {fullDate(thread.snoozedUntil)}</Badge>
            )}
            {labels.map((l) => (
              <Badge key={l} variant="secondary" className="font-normal">
                {l}
              </Badge>
            ))}
          </div>
        )}
        <div className="space-y-3">
          {messages.map((m, i) => (
            <Message key={m.id} message={m} defaultOpen={i === messages.length - 1 || m.unread} />
          ))}
        </div>
      </div>
    </div>
  )
}

function Message({ message: m, defaultOpen }: { message: MessageDetail; defaultOpen: boolean }) {
  const [open, setOpen] = useState(defaultOpen)
  const [html, setHtml] = useState<string | null | undefined>(undefined)
  const isDraft = m.labelIds.some((l) => l.endsWith(':DRAFT'))
  const files = m.attachments.filter((a) => !a.inline)

  useEffect(() => {
    if (!open || !m.hasHtml || html !== undefined) return
    let cancelled = false
    window.amc
      .messageHtml(m.id)
      .then((h) => !cancelled && setHtml(h))
      .catch(() => !cancelled && setHtml(null))
    return () => {
      cancelled = true
    }
  }, [open, m.hasHtml, m.id, html])

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
          ) : (
            <TextBody text={m.bodyText} />
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
