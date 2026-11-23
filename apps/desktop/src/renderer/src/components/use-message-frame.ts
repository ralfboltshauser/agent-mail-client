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
  const [state, setState] = useState({
    srcdoc,
    revision: 0,
    ready: false,
    height: MIN_HTML_BODY_HEIGHT,
    scroll: null as Geometry['scroll'],
  })
  const { revision, ready, height, scroll } = state
  if (state.srcdoc !== srcdoc) {
    setState({ srcdoc, revision: revision + 1, ready: false, height, scroll })
  }

  useLayoutEffect(() => {
    const el = frame.current
    if (!el) return
    // Every navigation has the same URL, including a consent change that replaces srcdoc.
    const marker = `amc-message-${revision}`
    const source = `<!--${marker}-->${srcdoc}`
    let discoveryFrame = 0
    let candidate: Document | undefined
    let disconnect: (() => void) | undefined

    const startSizing = () => {
      if (!candidate || candidate !== el.contentDocument || candidate.readyState === 'loading')
        return
      candidate.removeEventListener('readystatechange', startSizing)
      disconnect = observeMessageFrame(el, candidate, (next) => {
        setState((current) => {
          if (current.revision !== revision) return current
          if (current.ready && current.height === next.height && current.scroll === next.scroll)
            return current
          return { ...current, ...next, ready: true }
        })
      })
    }

    const discover = () => {
      if (candidate) return
      const doc = el.contentDocument
      if (doc?.URL !== 'about:srcdoc' || doc.firstChild?.nodeValue !== marker) return
      candidate = doc
      window.cancelAnimationFrame(discoveryFrame)
      doc.addEventListener('readystatechange', startSizing)
      startSizing()
    }
    const poll = () => {
      discover()
      if (!candidate) discoveryFrame = window.requestAnimationFrame(poll)
    }
    el.addEventListener('load', discover)
    if (el.srcdoc !== source) el.srcdoc = source
    poll()
    return () => {
      window.cancelAnimationFrame(discoveryFrame)
      el.removeEventListener('load', discover)
      candidate?.removeEventListener('readystatechange', startSizing)
      disconnect?.()
    }
  }, [srcdoc, revision])

  return { frame, ready, height, scroll }
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

  const setScrollableHeight = (height: number) => {
    fallbackHeight = Math.min(MAX_FALLBACK_HEIGHT, height)
    root.style.setProperty('overflow-y', 'auto', 'important')
    return fallbackHeight
  }

  const restartSizing = () => {
    heights.clear()
    requestedHeight = undefined
    if (fallbackHeight === undefined) return
    fallbackHeight = undefined
    root.style.setProperty('overflow-y', 'hidden', 'important')
  }

  const measure = (): Geometry | undefined => {
    if (!active || frame.contentDocument !== doc || frame.clientWidth === 0) return
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
        height = setScrollableHeight(Math.max(height, ...heights))
      } else {
        heights.add(height)
      }
      requestedHeight = height
    }

    const scroll = fallbackHeight !== undefined ? 'message' : horizontal ? 'horizontal' : null
    return { height, scroll }
  }

  const measureInitial = () => {
    const originalHeight = frame.style.height
    let largest = MIN_HTML_BODY_HEIGHT
    try {
      // Verify the layout at its proposed height while the iframe is hidden.
      // React publishes only the settled height, together with visibility.
      for (let pass = 0; pass <= MAX_AUTO_SIZE_PASSES; pass++) {
        const next = measure()
        if (!next || next.height === frame.offsetHeight) return next
        largest = Math.max(largest, next.height)
        frame.style.height = `${next.height}px`
      }
      frame.style.height = `${setScrollableHeight(largest)}px`
      width = frame.clientWidth
      return measure()
    } finally {
      frame.style.height = originalHeight
    }
  }

  const update = () => {
    const next = previous ? measure() : measureInitial()
    if (!next || (previous?.height === next.height && previous.scroll === next.scroll)) return
    previous = next
    onGeometry(next)
  }

  const schedule = () => {
    if (!active || pendingFrame !== undefined) return
    pendingFrame = window.requestAnimationFrame(() => {
      pendingFrame = undefined
      update()
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

  update()
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
    if (fallbackHeight !== undefined) root.style.setProperty('overflow-y', 'hidden', 'important')
    if (pendingFrame !== undefined) window.cancelAnimationFrame(pendingFrame)
    observer.disconnect()
    doc.removeEventListener('load', onResource, true)
    doc.removeEventListener('error', onResource, true)
    doc.removeEventListener('click', onClick)
    doc.removeEventListener('auxclick', onClick)
    doc.removeEventListener('keydown', onKey)
  }
}
