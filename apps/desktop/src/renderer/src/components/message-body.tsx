import { ImageOff } from 'lucide-react'
import { memo, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import {
  allowRemoteImagesFromSender,
  setLoadRemoteImagesAutomatically,
  useRemoteImages,
} from '@/data/remote-image-preferences'
import { dispatchMessageKeydown } from '@/hooks/use-hotkeys'
import { getAmc } from '@/lib/amc'
import { messageDocument, sanitizeMessageHtml } from './html-message-document'

export const MIN_HTML_BODY_HEIGHT = 120

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
  const frame = useRef<HTMLIFrameElement>(null)
  const [height, setHeight] = useState(MIN_HTML_BODY_HEIGHT)
  const { clean, hasRemote } = useMemo(() => sanitizeMessageHtml(html), [html])
  const doc = useMemo(() => messageDocument(clean, remote), [clean, remote])

  useLayoutEffect(() => {
    const el = frame.current
    if (!el) return
    let disconnect = () => {}
    const onLoad = () => {
      disconnect()
      const document = el.contentDocument
      const body = document?.body
      if (document?.URL !== 'about:srcdoc' || !body) return

      let observing = true
      const measure = () => {
        if (!observing || el.contentDocument !== document || el.closest('[hidden]')) return
        // The root scrollHeight has the current iframe viewport as a floor, even after content
        // shrinks. Measure the body so a previously tall version does not pin the height.
        const contentHeight = Math.max(
          body.scrollHeight,
          Math.ceil(body.getBoundingClientRect().height),
        )
        setHeight(Math.max(MIN_HTML_BODY_HEIGHT, contentHeight + 2))
      }
      const onClick = (event: MouseEvent) => {
        if (event.type === 'auxclick' && event.button !== 1) return
        const link = (event.target as Element | null)?.closest?.('a, area')
        if (!link) return
        event.preventDefault()
        const href = link.getAttribute('href') ?? link.getAttribute('xlink:href') ?? ''
        if (/^(https?|mailto):/i.test(href)) void getAmc().openExternal(href)
      }
      const onKey = (event: KeyboardEvent) => dispatchMessageKeydown(el, event)
      measure()
      const observer = new ResizeObserver(measure)
      observer.observe(body, { box: 'border-box' })
      document.addEventListener('click', onClick)
      document.addEventListener('auxclick', onClick)
      document.addEventListener('keydown', onKey)
      disconnect = () => {
        observing = false
        observer.disconnect()
        document.removeEventListener('click', onClick)
        document.removeEventListener('auxclick', onClick)
        document.removeEventListener('keydown', onKey)
      }
    }
    el.addEventListener('load', onLoad)
    if (el.srcdoc !== doc) el.srcdoc = doc
    return () => {
      el.removeEventListener('load', onLoad)
      disconnect()
    }
  }, [doc])

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
      <iframe
        ref={frame}
        title="Message"
        sandbox="allow-same-origin"
        className="block w-full rounded-md border border-border/70 bg-white"
        style={{ height }}
      />
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
        className="text-primary underline-offset-2 hover:underline"
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
