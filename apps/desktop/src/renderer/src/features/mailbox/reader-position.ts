type ReadingPosition = { top: number; measure: () => number | undefined }

export function captureReadingPosition(scroll: HTMLDivElement): ReadingPosition | undefined {
  const content = scroll.firstElementChild
  if (scroll.scrollTop === 0 || !content) return
  const viewport = scroll.getBoundingClientRect()
  const column = content.getBoundingClientRect()
  const x = column.left + column.width / 2
  const y = viewport.top + 24
  const target = scroll.ownerDocument.elementFromPoint?.(x, y)
  if (!target || !content.contains(target)) return

  let measure: () => number | undefined
  if (target instanceof HTMLIFrameElement) {
    const frameDocument = target.contentDocument
    if (frameDocument?.URL !== 'about:srcdoc') return
    const frameTop = () => target.getBoundingClientRect().top + target.clientTop
    const inFrame = anchorAtPoint(
      frameDocument.body,
      x - target.getBoundingClientRect().left - target.clientLeft,
      y - frameTop(),
    )
    measure = () => {
      if (target.contentDocument !== frameDocument) return
      const top = inFrame?.()
      if (top !== undefined) return frameTop() + top
    }
  } else {
    const inReader = anchorAtPoint(content, x, y)
    measure = () => inReader?.()
  }

  const firstTop = measure()
  if (firstTop === undefined) return
  return {
    top: firstTop - viewport.top,
    measure: () => {
      const top = measure()
      if (top !== undefined) return top - scroll.getBoundingClientRect().top
    },
  }
}

function anchorAtPoint(root: Element, x: number, y: number) {
  const doc = root.ownerDocument
  const range = doc.caretRangeFromPoint?.(x, y)
  const node = range?.startContainer
  if (range && node?.nodeType === Node.TEXT_NODE && root.contains(node)) {
    const rect = range.getBoundingClientRect()
    if (rect.height > 0 && Math.abs(rect.top - y) < 32) {
      return () => {
        if (root.contains(node) && range.startContainer === node) {
          return range.getBoundingClientRect().top
        }
      }
    }
  }
  const element = doc.elementFromPoint?.(x, y)
  if (element && element !== root && root.contains(element)) {
    return () => (root.contains(element) ? element.getBoundingClientRect().top : undefined)
  }
}

export function restoreReadingPosition(scroll: HTMLDivElement, position: ReadingPosition) {
  let expected = scroll.scrollTop
  const adjust = () => {
    if (scroll.scrollTop !== expected) {
      stop()
      return
    }
    const current = position.measure()
    if (current === undefined) return
    scroll.scrollTop += current - position.top
    expected = scroll.scrollTop
  }
  // The iframe can report a new height after the reader's width has already changed.
  const observer = new ResizeObserver(adjust)
  const timeout = window.setTimeout(stop, 150)
  function stop() {
    observer.disconnect()
    window.clearTimeout(timeout)
    scroll.removeEventListener('wheel', stop)
    scroll.removeEventListener('pointerdown', stop)
    scroll.removeEventListener('keydown', stop)
  }
  scroll.addEventListener('wheel', stop, { passive: true })
  scroll.addEventListener('pointerdown', stop)
  scroll.addEventListener('keydown', stop)
  if (scroll.firstElementChild) observer.observe(scroll.firstElementChild)
  adjust()
  return stop
}
