import DOMPurify from 'dompurify'

const BASE_CSS = `
  :root { color-scheme: light; }
  html, body { margin: 0; padding: 0; background: #fff; color: #1f1f23;
    font: 14px/1.55 -apple-system, BlinkMacSystemFont, "SF Pro Text", system-ui, sans-serif;
    overflow-wrap: anywhere; }
  body { padding: 16px 20px; }
  img, video { max-width: 100%; height: auto; }
  img[width][height] { aspect-ratio: auto attr(width type(<number>)) / attr(height type(<number>)); }
  table { max-width: 100%; }
  pre { white-space: pre-wrap; }
  a { color: #3b5bdb; }
  blockquote { margin: 0 0 0 .6em; padding-left: .8em; border-left: 2px solid #d4d4d8; color: #52525b; }
`

export function sanitizeMessageHtml(html: string) {
  // WHOLE_DOCUMENT with RETURN_DOM returns the sanitized HTML root element.
  const clean = DOMPurify.sanitize(html, {
    WHOLE_DOCUMENT: true,
    RETURN_DOM: true,
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
  }) as HTMLHtmlElement
  // Before the parent attaches link handlers, the sandbox blocks links targeting new windows.
  for (const link of clean.querySelectorAll('a, area')) link.setAttribute('target', '_blank')
  const remoteUrl = /^\s*(?:https?:)?\/\//i
  const remoteCss = /url\(\s*["']?\s*(?:https?:)?\/\//i
  const hasRemote = [clean, ...clean.querySelectorAll('*')].some(
    (element) =>
      Array.from(element.attributes).some(({ name, value }) => {
        if (name === 'style') return remoteCss.test(value)
        if (name === 'srcset') return /(?:^|[,\s])(?:https?:)?\/\//i.test(value)
        return (
          (name === 'background' ||
            (name === 'src' && element.localName === 'img') ||
            ((name === 'href' || name === 'xlink:href') && element.localName === 'image')) &&
          remoteUrl.test(value)
        )
      }) ||
      (element.localName === 'style' && remoteCss.test(element.textContent ?? '')),
  )
  return { clean: clean.outerHTML, hasRemote }
}

export function messageDocument(clean: string, remote: boolean) {
  const imgSrc = remote ? 'data: cid: https: http:' : 'data: cid:'
  const csp = `default-src 'none'; img-src ${imgSrc}; style-src 'unsafe-inline'; font-src data:; media-src 'none'; form-action 'none'`
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}"><style>${BASE_CSS}</style></head><body>${clean}</body></html>`
}
