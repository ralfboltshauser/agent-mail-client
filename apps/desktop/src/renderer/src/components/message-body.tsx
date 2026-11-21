import DOMPurify from 'dompurify'
import { ImageOff } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'

const BASE_CSS = `
  :root { color-scheme: light; }
  html, body { margin: 0; padding: 0; background: #fff; color: #1f1f23;
    font: 14px/1.55 -apple-system, BlinkMacSystemFont, "SF Pro Text", system-ui, sans-serif;
    overflow-wrap: anywhere; }
  body { padding: 16px 20px; }
  img, video { max-width: 100%; height: auto; }
  table { max-width: 100%; }
  pre { white-space: pre-wrap; }
  a { color: #3b5bdb; }
  blockquote { margin: 0 0 0 .6em; padding-left: .8em; border-left: 2px solid #d4d4d8; color: #52525b; }
`

/**
 * Renders an HTML mail body safely: sanitized, in a sandboxed iframe without scripts, with a
 * Content-Security-Policy that blocks remote images (tracking pixels) until the owner allows
 * them. Links open in the default browser, never inside AMC.
 */
export function HtmlBody({ html }: { html: string }) {
  const [remote, setRemote] = useState(false)
  const frame = useRef<HTMLIFrameElement>(null)
  const [height, setHeight] = useState(120)

  const { doc, hasRemote } = useMemo(() => {
    const clean = DOMPurify.sanitize(html, {
      WHOLE_DOCUMENT: true,
      FORBID_TAGS: [
        'form',
        'input',
        'button',
        'textarea',
        'select',
        'script',
        'iframe',
        'object',
        'embed',
        'base',
        'meta',
        'link',
      ],
      FORBID_ATTR: ['onerror', 'onload', 'onclick'],
    })
    const hasRemote = /<img[^>]+src=["']?https?:|url\(\s*["']?https?:/i.test(clean)
    const imgSrc = remote ? 'data: cid: https: http:' : 'data: cid:'
    const csp = `default-src 'none'; img-src ${imgSrc}; style-src 'unsafe-inline'; font-src data:; media-src 'none'`
    const doc = `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}"><style>${BASE_CSS}</style></head><body>${clean}</body></html>`
    return { doc, hasRemote }
  }, [html, remote])

  useEffect(() => {
    const el = frame.current
    if (!el) return
    let observer: ResizeObserver | null = null
    const onLoad = () => {
      const d = el.contentDocument
      if (!d) return
      const measure = () => setHeight(Math.max(60, d.documentElement.scrollHeight))
      measure()
      observer = new ResizeObserver(measure)
      observer.observe(d.documentElement)
      d.addEventListener('click', (event) => {
        const link = (event.target as Element | null)?.closest?.(
          'a[href]',
        ) as HTMLAnchorElement | null
        if (!link) return
        event.preventDefault()
        const href = link.getAttribute('href') ?? ''
        if (/^(https?|mailto):/i.test(href)) void window.amc.openExternal(href)
      })
    }
    el.addEventListener('load', onLoad)
    return () => {
      el.removeEventListener('load', onLoad)
      observer?.disconnect()
    }
  }, [])

  return (
    <div className="space-y-2">
      {hasRemote && !remote && (
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <ImageOff className="size-3.5" />
          Remote images are blocked so the sender can't see you opened this.
          <Button
            variant="link"
            size="sm"
            className="h-auto p-0 text-xs"
            onClick={() => setRemote(true)}
          >
            Load images
          </Button>
        </div>
      )}
      <iframe
        ref={frame}
        title="Message"
        sandbox="allow-same-origin"
        srcDoc={doc}
        className="w-full rounded-md border border-border/70 bg-white"
        style={{ height }}
      />
    </div>
  )
}

/** Plain-text bodies: keep line breaks, linkify URLs, fold quoted history. */
export function TextBody({ text }: { text: string }) {
  const [showQuoted, setShowQuoted] = useState(false)
  const lines = text.split('\n')
  const quoteStart = lines.findIndex(
    (l, i) =>
      /^On .+wrote:$/.test(l.trim()) ||
      (l.startsWith('>') && lines.slice(i).every((x) => !x.trim() || x.startsWith('>'))),
  )
  const visible = quoteStart > 0 && !showQuoted ? lines.slice(0, quoteStart) : lines
  return (
    <div className="select-text whitespace-pre-wrap break-words text-[14px] leading-relaxed text-foreground/90">
      {linkify(visible.join('\n').trimEnd())}
      {quoteStart > 0 && !showQuoted && (
        <button
          type="button"
          className="mt-2 block rounded bg-muted px-2 text-xs text-muted-foreground hover:bg-muted/70"
          onClick={() => setShowQuoted(true)}
        >
          •••
        </button>
      )}
    </div>
  )
}

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
          void window.amc.openExternal(part)
        }}
      >
        {part}
      </a>
    ) : (
      part
    ),
  )
}
