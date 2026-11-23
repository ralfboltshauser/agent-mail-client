import { useCallback, useLayoutEffect, useRef, useState } from 'react'
import { captureReadingPosition, restoreReadingPosition } from './reader-position'

export function useReaderFocus(
  scope: string,
  selectedId: string | null,
  canExpand: boolean,
  compact: boolean,
) {
  const [route, setRoute] = useState<{ scope: string; focus: boolean } | null>(null)
  const current = route?.scope === scope && selectedId !== null ? route : null
  if (route !== current) setRoute(null)
  const expanded = current !== null && (compact || current.focus)
  const visible = !compact || expanded
  const reader = useRef<HTMLDivElement>(null)
  const scroll = useRef<HTMLDivElement>(null)
  const list = useRef<HTMLDivElement>(null)
  const invoker = useRef<{
    element: HTMLElement | null
    scope: string
    threadId: string | null
  } | null>(null)
  const returnTo = useRef<HTMLElement | null>(null)
  const previousLayout = useRef({ expanded, compact })
  const readingPosition = useRef<{
    threadId: string | null
    position: NonNullable<ReturnType<typeof captureReadingPosition>>
  }>(null)

  const rememberReadingPosition = () => {
    const position = scroll.current && captureReadingPosition(scroll.current)
    readingPosition.current = position ? { threadId: selectedId, position } : null
  }

  const collapse = useCallback(() => setRoute(null), [])
  const open = useCallback(
    (destination: string) =>
      setRoute((previous) =>
        previous?.scope === destination ? previous : { scope: destination, focus: false },
      ),
    [],
  )
  const exit = (target?: HTMLElement | null) => {
    rememberReadingPosition()
    returnTo.current = target ?? null
    collapse()
  }
  const toggle = (element: HTMLElement | null) => {
    if (expanded) {
      exit()
    } else if (canExpand) {
      rememberReadingPosition()
      invoker.current = { element, scope, threadId: selectedId }
      setRoute({ scope, focus: !compact })
    }
  }

  useLayoutEffect(() => {
    const previous = previousLayout.current
    const resized = compact !== previous.compact
    const changed = expanded !== previous.expanded
    previousLayout.current = { expanded, compact }
    const captured = changed ? readingPosition.current : null
    if (changed) readingPosition.current = null
    const stopRestoring =
      captured?.threadId === selectedId && scroll.current
        ? restoreReadingPosition(scroll.current, captured.position)
        : undefined
    if (expanded) {
      const target = scroll.current ?? reader.current
      if (
        document.activeElement === document.body ||
        (changed && (!resized || !reader.current?.contains(document.activeElement)))
      ) {
        target?.focus({ preventScroll: true })
      }
      return stopRestoring
    }
    if (resized && visible && reader.current?.contains(document.activeElement)) return stopRestoring
    if (!changed && (!resized || visible || document.activeElement !== document.body)) return
    const trigger =
      invoker.current?.scope === scope && invoker.current.threadId === selectedId
        ? invoker.current.element
        : null
    const target = returnTo.current ?? trigger
    if (target?.isConnected) target.focus({ preventScroll: true })
    if (!target || document.activeElement !== target) {
      const fallback =
        list.current?.querySelector<HTMLElement>('[role="listbox"]') ??
        list.current?.querySelector<HTMLElement>('[data-mailbox-heading]')
      fallback?.focus({ preventScroll: true })
    }
    invoker.current = null
    returnTo.current = null
    return stopRestoring
  }, [compact, expanded, scope, selectedId, visible])

  return {
    expanded,
    visible,
    compact,
    canExpand,
    reader,
    scroll,
    list,
    toggle,
    exit,
    collapse,
    open,
  }
}
