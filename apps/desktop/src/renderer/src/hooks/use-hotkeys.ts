import { useEffect, useRef } from 'react'

export type HotkeyMap = Record<string, (event: KeyboardEvent) => void>

function isTyping(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null
  return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)
}

/**
 * Global keyboard shortcuts. Keys look like "j", "shift+3", "mod+k" (mod = ⌘), and
 * two-key sequences like "g i". Plain keys are ignored while typing; "mod+…" and "escape" are not.
 */
export function useHotkeys(map: HotkeyMap): void {
  const mapRef = useRef(map)
  mapRef.current = map
  useEffect(() => {
    let pending: string | null = null
    let pendingTimer: number | undefined
    const onKey = (event: KeyboardEvent) => {
      if (event.isComposing) return
      const key = event.key.length === 1 ? event.key.toLowerCase() : event.key.toLowerCase()
      const combo = [
        event.metaKey ? 'mod' : '',
        event.ctrlKey ? 'ctrl' : '',
        event.altKey ? 'alt' : '',
        event.shiftKey && key.length > 1 ? 'shift' : '',
        key,
      ]
        .filter(Boolean)
        .join('+')
      const typing = isTyping(event.target)
      if (typing && !combo.startsWith('mod+') && combo !== 'escape') return

      const handlers = mapRef.current
      if (pending) {
        const seq = `${pending} ${combo}`
        pending = null
        window.clearTimeout(pendingTimer)
        if (handlers[seq]) {
          event.preventDefault()
          handlers[seq](event)
          return
        }
      }
      if (Object.keys(handlers).some((k) => k.startsWith(`${combo} `))) {
        pending = combo
        pendingTimer = window.setTimeout(() => {
          pending = null
        }, 1200)
        event.preventDefault()
        return
      }
      const handler = handlers[combo]
      if (handler) {
        event.preventDefault()
        handler(event)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
}
