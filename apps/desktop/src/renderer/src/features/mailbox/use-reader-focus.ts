import { useCallback, useLayoutEffect, useRef, useState } from 'react'
import { captureReadingPosition, restoreReadingPosition } from './reader-position'

export function useReaderFocus(scope: string, selectedId: string | null, canExpand: boolean) {
  const [expandedScope, setExpandedScope] = useState<string | null>(null)
  const expanded = expandedScope === scope && selectedId !== null
  if (expandedScope !== null && !expanded) setExpandedScope(null)
  const reader = useRef<HTMLDivElement>(null)
  const scroll = useRef<HTMLDivElement>(null)
  const list = useRef<HTMLDivElement>(null)
  const invoker = useRef<{ element: HTMLElement | null; threadId: string | null } | null>(null)
  const returnTo = useRef<HTMLElement | null>(null)
  const wasExpanded = useRef(false)
  const readingPosition = useRef<{
    threadId: string | null
    position: NonNullable<ReturnType<typeof captureReadingPosition>>
  }>(null)

  const rememberReadingPosition = () => {
    const position = scroll.current && captureReadingPosition(scroll.current)
    readingPosition.current = position ? { threadId: selectedId, position } : null
  }

  const collapse = useCallback(() => setExpandedScope(null), [])
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
      invoker.current = { element, threadId: selectedId }
      setExpandedScope(scope)
    }
  }

  useLayoutEffect(() => {
    const changed = expanded !== wasExpanded.current
    wasExpanded.current = expanded
    const captured = changed ? readingPosition.current : null
    if (changed) readingPosition.current = null
    const stopRestoring =
      captured?.threadId === selectedId && scroll.current
        ? restoreReadingPosition(scroll.current, captured.position)
        : undefined
    if (expanded) {
      const target = scroll.current ?? reader.current
      if (changed || document.activeElement === document.body) {
        target?.focus({ preventScroll: true })
      }
      return stopRestoring
    }
    if (!changed) return
    const trigger = invoker.current?.threadId === selectedId ? invoker.current.element : null
    const target = returnTo.current ?? trigger
    if (target?.isConnected) target.focus({ preventScroll: true })
    if (!target?.isConnected || document.activeElement === document.body) {
      const fallback =
        list.current?.querySelector<HTMLElement>('[role="listbox"]') ??
        list.current?.querySelector<HTMLElement>('[data-mailbox-heading]')
      fallback?.focus({ preventScroll: true })
    }
    invoker.current = null
    returnTo.current = null
    return stopRestoring
  }, [expanded, selectedId])

  return { expanded, canExpand, reader, scroll, list, toggle, exit, collapse }
}
