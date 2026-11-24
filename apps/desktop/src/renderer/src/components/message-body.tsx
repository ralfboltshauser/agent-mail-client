import { ImageOff } from 'lucide-react'
import { memo, useMemo, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import {
  allowRemoteImagesFromSender,
  setLoadRemoteImagesAutomatically,
  useRemoteImages,
} from '@/data/remote-image-preferences'
import { getAmc } from '@/lib/amc'
import { messageDocument, sanitizeMessageHtml } from './html-message-document'

import { MIN_HTML_BODY_HEIGHT, useMessageFrame } from './use-message-frame'

export function HtmlBodySkeleton({ decorative = false }: { decorative?: boolean }) {
  return (
    <div
      className="space-y-2 py-2"
      style={{ minHeight: MIN_HTML_BODY_HEIGHT }}
      aria-busy={decorative ? undefined : true}
      aria-hidden={decorative ? true : undefined}
      data-reader-body-pending={decorative ? undefined : ''}
    >
      <Skeleton className="h-3 w-3/4" />
      <Skeleton className="h-3 w-2/3" />
      <Skeleton className="h-3 w-1/2" />
    </div>
  )
}

/**
 * Renders sanitized HTML in a sandboxed iframe. Links open in the default browser.
 */
export const HtmlBody = memo(function HtmlBody({
  html,
  senderKey,
}: {
  html: string
  senderKey: string | null
}) {
  const [loadOnce, setLoadOnce] = useState(false)
  const permitted = useRemoteImages(senderKey)
  const remote = loadOnce || permitted
  const { clean, hasRemote } = useMemo(() => sanitizeMessageHtml(html), [html])
  const doc = useMemo(() => messageDocument(clean, remote), [clean, remote])

  const { frame, ready, height, scroll } = useMessageFrame(doc)

  return (
    <div className="space-y-2">
      {hasRemote && !remote && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
          <span className="inline-flex items-center gap-2">
            <ImageOff aria-hidden="true" className="size-3.5 shrink-0" />
            Remote images are blocked.
          </span>
          <Button
            variant="link"
            size="sm"
            className="h-auto p-0 text-xs"
            onClick={() => setLoadOnce(true)}
          >
            Load images
          </Button>
          <Button
            variant="link"
            size="sm"
            className="h-auto p-0 text-xs"
            onClick={() => setLoadRemoteImagesAutomatically(true)}
          >
            Always load
          </Button>
          {senderKey && (
            <Button
              variant="link"
              size="sm"
              className="h-auto p-0 text-xs"
              onClick={() => allowRemoteImagesFromSender(senderKey)}
            >
              Always from this sender
            </Button>
          )}
        </div>
      )}
      {scroll && (
        <Button
          variant="link"
          size="sm"
          className={ready ? 'h-auto p-0 text-xs' : 'invisible h-auto p-0 text-xs'}
          onClick={() => frame.current?.focus({ preventScroll: true })}
        >
          {scroll === 'horizontal' ? 'Scroll message horizontally' : 'Scroll within message'}
        </Button>
      )}
      <div
        className="relative"
        aria-busy={!ready || undefined}
        data-reader-body-pending={ready ? undefined : ''}
      >
        {!ready && (
          <div className="absolute inset-0">
            <HtmlBodySkeleton decorative />
          </div>
        )}
        <iframe
          ref={frame}
          title="Message"
          sandbox="allow-same-origin"
          data-reader-html-ready={ready ? '' : undefined}
          className="block w-full rounded-md border border-border/70 bg-white focus-visible:outline-2 focus-visible:outline-ring"
          // Chromium uses the embedding element's scheme for the message's media queries.
          style={{ height, visibility: ready ? 'visible' : 'hidden', colorScheme: 'only light' }}
        />
      </div>
    </div>
  )
})

/** Plain-text bodies: keep line breaks, linkify URLs, fold quoted history. */
export const TextBody = memo(function TextBody({ text }: { text: string }) {
  const [showQuoted, setShowQuoted] = useState(false)
  const lines = text.split('\n')
  const quoteStart = lines.findIndex(
    (l, i) =>
      /^On .+wrote:$/.test(l.trim()) ||
      (l.startsWith('>') && lines.slice(i).every((x) => !x.trim() || x.startsWith('>'))),
  )
  const visible = quoteStart > 0 && !showQuoted ? lines.slice(0, quoteStart) : lines
  return (
    <div className="max-w-[65ch] select-text wrap-anywhere whitespace-pre-wrap text-sm leading-[1.7] text-foreground/95">
      {linkify(visible.join('\n').trimEnd())}
      {quoteStart > 0 && !showQuoted && (
        <button
          type="button"
          aria-label="Show quoted text"
          className="mt-2 block rounded bg-muted px-2 text-xs text-muted-foreground hover:bg-muted/70"
          onClick={() => setShowQuoted(true)}
        >
          •••
        </button>
      )}
    </div>
  )
})

function linkify(text: string): React.ReactNode[] {
  const parts = text.split(/(https?:\/\/[^\s<>"')\]]+)/g)
  return parts.map((part, i) =>
    /^https?:\/\//.test(part) ? (
      <a
        // biome-ignore lint/suspicious/noArrayIndexKey: positional text segments
        key={i}
        href={part}
        className="text-primary underline underline-offset-2"
        onClick={(e) => {
          e.preventDefault()
          void getAmc().openExternal(part)
        }}
      >
        {part}
      </a>
    ) : (
      part
    ),
  )
}
