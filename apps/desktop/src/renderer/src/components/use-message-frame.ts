import { useLayoutEffect, useRef, useState } from 'react'
import { dispatchMessageKeydown } from '@/hooks/use-hotkeys'
import { getAmc } from '@/lib/amc'

export const MIN_HTML_BODY_HEIGHT = 120
const MAX_AUTO_SIZE_PASSES = 6
const MAX_FALLBACK_HEIGHT = 640
const FRAME_BORDER = 2

type Geometry = { height: number; scroll: 'horizontal' | 'message' | null }

export function useMessageFrame(srcdoc: string) {
  const frame = useRef<HTMLIFrameElement>(null)
  const [geometry, setGeometry] = useState<Geometry>({ height: MIN_HTML_BODY_HEIGHT, scroll: null })

  useLayoutEffect(() => {
    const el = frame.current
    if (!el) return
    let disconnect = () => {}
    const onLoad = () => {
      disconnect()
      const doc = el.contentDocument
      if (doc?.URL !== 'about:srcdoc' || !doc.body || !doc.defaultView) return
      disconnect = observeMessageFrame(el, doc, (next) => {
        setGeometry((current) =>
          current.height === next.height && current.scroll === next.scroll ? current : next,
        )
      })
    }
    el.addEventListener('load', onLoad)
    if (el.srcdoc !== srcdoc) el.srcdoc = srcdoc
    return () => {
      el.removeEventListener('load', onLoad)
      disconnect()
    }
  }, [srcdoc])

  return { frame, ...geometry }
}

function observeMessageFrame(
  frame: HTMLIFrameElement,
  doc: Document,
  onGeometry: (geometry: Geometry) => void,
) {
  const root = doc.documentElement
  const body = doc.body
  const senderZoom = root.style.getPropertyValue('zoom')
  const senderZoomPriority = root.style.getPropertyPriority('zoom')
  let fitted = false
  let active = true
  let pendingFrame: number | undefined
  let width = frame.clientWidth
  let requestedHeight: number | undefined
  let fallbackHeight: number | undefined
  let previous: Geometry | undefined
  const heights = new Set<number>()

  const restartSizing = () => {
    heights.clear()
    requestedHeight = undefined
    if (fallbackHeight === undefined) return
    fallbackHeight = undefined
    root.style.setProperty('overflow-y', 'hidden', 'important')
  }

  const measure = () => {
    if (!active || frame.contentDocument !== doc || frame.closest('[hidden]')) return
    const viewport = doc.defaultView
    if (!viewport) return
    if (width !== frame.clientWidth) {
      width = frame.clientWidth
      restartSizing()
    }
    if (fitted) {
      root.style.setProperty('zoom', senderZoom, senderZoomPriority)
      fitted = false
    }
    const availableWidth = root.clientWidth
    const contentWidth = root.scrollWidth
    if (availableWidth > 0 && contentWidth > availableWidth) {
      // Zoom participates in layout, so frame height includes the scaled content.
      root.style.setProperty(
        'zoom',
        String((root.currentCSSZoom * availableWidth) / contentWidth),
        'important',
      )
      fitted = true
    }
    const horizontal = root.scrollWidth > root.clientWidth
    let height = fallbackHeight
    if (height === undefined) {
      const bodyRect = body.getBoundingClientRect()
      const bodyTop = bodyRect.top + viewport.scrollY
      // Root scrollHeight includes the viewport. Use it only when content extends past it.
      const rootOverflow = root.scrollHeight > root.clientHeight ? root.scrollHeight : 0
      const contentHeight = Math.max(
        bodyRect.height + bodyTop,
        body.scrollHeight * (body.currentCSSZoom ?? 1) + bodyTop,
        rootOverflow,
      )
      const scrollbar = horizontal ? Math.max(0, viewport.innerHeight - root.clientHeight) : 0
      height = Math.max(MIN_HTML_BODY_HEIGHT, Math.ceil(contentHeight) + scrollbar + FRAME_BORDER)

      if (height === requestedHeight) {
        if (frame.offsetHeight === height) heights.clear()
      } else if (heights.has(height) || heights.size >= MAX_AUTO_SIZE_PASSES) {
        fallbackHeight = Math.min(MAX_FALLBACK_HEIGHT, Math.max(height, ...heights))
        root.style.setProperty('overflow-y', 'auto', 'important')
        height = fallbackHeight
      } else {
        heights.add(height)
      }
      requestedHeight = height
    }

    const scroll = fallbackHeight !== undefined ? 'message' : horizontal ? 'horizontal' : null
    if (previous?.height === height && previous.scroll === scroll) return
    previous = { height, scroll }
    onGeometry(previous)
  }

  const schedule = () => {
    if (!active || pendingFrame !== undefined) return
    pendingFrame = window.requestAnimationFrame(() => {
      pendingFrame = undefined
      measure()
    })
  }
  const onResource = (event: Event) => {
    const tag = (event.target as Element | null)?.localName
    if (tag !== 'img' && tag !== 'image') return
    restartSizing()
    schedule()
  }
  const onClick = (event: MouseEvent) => {
    if (event.type === 'auxclick' && event.button !== 1) return
    const link = (event.target as Element | null)?.closest?.('a, area')
    if (!link) return
    event.preventDefault()
    const href = link.getAttribute('href') ?? link.getAttribute('xlink:href') ?? ''
    if (/^(https?|mailto):/i.test(href)) void getAmc().openExternal(href)
  }
  const onKey = (event: KeyboardEvent) => dispatchMessageKeydown(frame, event)

  measure()
  const observer = new ResizeObserver(schedule)
  observer.observe(body, { box: 'border-box' })
  observer.observe(frame, { box: 'border-box' })
  doc.addEventListener('load', onResource, true)
  doc.addEventListener('error', onResource, true)
  doc.addEventListener('click', onClick)
  doc.addEventListener('auxclick', onClick)
  doc.addEventListener('keydown', onKey)
  return () => {
    active = false
    if (fitted) root.style.setProperty('zoom', senderZoom, senderZoomPriority)
    if (pendingFrame !== undefined) window.cancelAnimationFrame(pendingFrame)
    observer.disconnect()
    doc.removeEventListener('load', onResource, true)
    doc.removeEventListener('error', onResource, true)
    doc.removeEventListener('click', onClick)
    doc.removeEventListener('auxclick', onClick)
    doc.removeEventListener('keydown', onKey)
  }
}
