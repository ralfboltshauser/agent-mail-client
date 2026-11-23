import DOMPurify from 'dompurify'

const BASE_CSS = `
  :where(html) { background: #fff; color: #1f1f1f;
    font: 14px/1.55 -apple-system, BlinkMacSystemFont, "SF Pro Text", system-ui, sans-serif;
    overflow-wrap: break-word; }
  :where(html, body) { margin: 0; padding: 0; }
  :where(body) { padding: 16px clamp(8px, 3.2vw, 20px); }
  /* Data values can contain long identifiers. Preserve intrinsic sizing for headings and
     for layout cells that contain nested tables. */
  :where(table:has(> thead) > tbody > tr > td:not(:has(table))) { overflow-wrap: anywhere; }
  :where(img, video) { max-inline-size: 100%; }
  :where(img[width][height], video[width][height]) {
    aspect-ratio: attr(width type(<number>)) / attr(height type(<number>));
    height: auto;
  }
  :where(a) { color: inherit; text-decoration: underline; }
  :where(a:focus-visible) { outline: 2px solid currentColor; outline-offset: 2px; }
  ::selection { background: #333; color: #fff; }
  :where(blockquote) { margin: 0 0 0 .6em; padding-left: .8em; border-left: 2px solid #d4d4d4; color: #525252; }
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
  return { clean, hasRemote }
}

export function messageDocument(clean: HTMLHtmlElement, remote: boolean) {
  const root = clean.cloneNode(true) as HTMLHtmlElement
  const doc = root.ownerDocument
  const head = root.querySelector('head') ?? doc.createElement('head')
  if (!head.parentNode) root.prepend(head)
  const imgSrc = remote ? 'data: cid: https: http:' : 'data: cid:'
  const csp = `default-src 'none'; img-src ${imgSrc}; style-src 'unsafe-inline'; font-src data:; media-src 'none'; form-action 'none'`
  const charset = doc.createElement('meta')
  charset.setAttribute('charset', 'utf-8')
  const policy = doc.createElement('meta')
  policy.httpEquiv = 'Content-Security-Policy'
  policy.content = csp
  const colorScheme = doc.createElement('meta')
  colorScheme.name = 'color-scheme'
  colorScheme.content = 'only light'
  const styles = doc.createElement('style')
  styles.textContent = BASE_CSS
  head.prepend(charset, policy, colorScheme, styles)

  // The reader owns scrolling at the viewport. A sender can still size and clip its
  // inner layout, but root/body overflow must not hide the rest of the message.
  root.style.setProperty('overflow', 'auto hidden', 'important')
  root.querySelector('body')?.style.setProperty('overflow', 'visible', 'important')
  return `<!doctype html>${root.outerHTML}`
}
