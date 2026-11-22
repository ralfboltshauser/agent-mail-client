import type { Virtualizer } from '@tanstack/react-virtual'
import { type RefObject, useCallback, useLayoutEffect, useRef } from 'react'

/** Keep the leading visible item at its pixel offset when preceding sections change. */
export function useInboxScrollAnchor(
  scrollRef: RefObject<HTMLDivElement | null>,
  virtualizer: Virtualizer<HTMLDivElement, HTMLDivElement>,
  positions: ReadonlyMap<string, number>,
  sectioned: boolean,
) {
  const anchor = useRef<{ id: string; distance: number } | null>(null)
  const rememberAnchor = useCallback(() => {
    const scroll = scrollRef.current
    const item = scroll && virtualizer.getVirtualItemForOffset(scroll.scrollTop)
    anchor.current =
      item && typeof item.key === 'string'
        ? { id: item.key, distance: scroll.scrollTop - item.start }
        : null
  }, [scrollRef, virtualizer])
  useLayoutEffect(() => {
    const previous = anchor.current
    if (previous && sectioned) {
      const index = positions.get(previous.id)
      const offset =
        index === undefined ? undefined : virtualizer.getOffsetForIndex(index, 'start')?.[0]
      if (offset !== undefined) virtualizer.scrollToOffset(offset + previous.distance)
    }
    rememberAnchor()
  }, [positions, sectioned, rememberAnchor, virtualizer])

  return rememberAnchor
}
