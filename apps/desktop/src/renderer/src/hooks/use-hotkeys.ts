import { type RefObject, useEffect, useLayoutEffect, useRef } from 'react'
import { mailShortcuts, tooltipDismissals } from '@/lib/mail-shortcuts'

type HotkeyHandler = (event: KeyboardEvent) => void
type HotkeyBinding = HotkeyHandler | { run: HotkeyHandler; when: (event: KeyboardEvent) => boolean }
export type HotkeyMap = Record<string, HotkeyBinding>
export const messageKeydownEvent = 'amc:message-keydown'
const messageKeys = new Set([
  mailShortcuts.focusReader,
  mailShortcuts.escape,
  mailShortcuts.reply,
  'j',
  'k',
  'space',
  mailShortcuts.filterMail,
  mailShortcuts.searchMail,
  'mod+k',
  mailShortcuts.copyThreadReference,
])

export function dispatchMessageKeydown(frame: HTMLIFrameElement, event: KeyboardEvent) {
  frame.dispatchEvent(new CustomEvent(messageKeydownEvent, { bubbles: true, detail: event }))
}

function isTyping(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null
  return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)
}

function runBinding(binding: HotkeyBinding, event: KeyboardEvent) {
  if (typeof binding !== 'function' && !binding.when(event)) return
  event.preventDefault()
  const run = typeof binding === 'function' ? binding : binding.run
  run(event)
}

/**
 * Global keyboard shortcuts. Keys look like "j", "shift+3", "mod+k" (mod = ⌘), and
 * two-key sequences like "g i". Plain keys are ignored while typing; "mod+…" and "escape" are not.
 */
export function useHotkeys(
  map: HotkeyMap,
  enabled = true,
  messageRoot?: RefObject<HTMLElement | null>,
): void {
  const mapRef = useRef(map)
  useLayoutEffect(() => {
    mapRef.current = map
  }, [map])
  useEffect(() => {
    if (!enabled) return
    let pending: string | null = null
    let pendingTimer: number | undefined
    const handleKey = (event: KeyboardEvent, fromMessage: boolean) => {
      const target = event.target as Element | null
      const inOverlay = target?.closest?.(
        'dialog[open], [role="dialog"], [role="alertdialog"], [role="menu"]',
      )
      if (
        event.isComposing ||
        event.keyCode === 229 ||
        (event.defaultPrevented && !tooltipDismissals.has(event)) ||
        inOverlay
      )
        return
      const key = event.key === ' ' ? 'space' : event.key.toLowerCase()
      if (
        key === 'space' &&
        target?.closest?.('button, a, summary, [role="button"], [role="menuitem"]')
      )
        return
      const combo = [
        event.metaKey ? 'mod' : '',
        event.ctrlKey ? 'ctrl' : '',
        event.altKey ? 'alt' : '',
        event.shiftKey && (key.length > 1 || /^[a-z]$/.test(key)) ? 'shift' : '',
        key,
      ]
        .filter(Boolean)
        .join('+')
      const typing = isTyping(event.target)
      if (typing && !combo.startsWith('mod+') && combo !== 'escape') return

      const handlers = mapRef.current
      const available = (command: string) =>
        !fromMessage || command.startsWith('g ') || messageKeys.has(command)
      if (pending) {
        const seq = `${pending} ${combo}`
        pending = null
        window.clearTimeout(pendingTimer)
        if (available(seq) && handlers[seq]) {
          runBinding(handlers[seq], event)
          return
        }
      }
      if (Object.keys(handlers).some((k) => k.startsWith(`${combo} `) && available(k))) {
        pending = combo
        pendingTimer = window.setTimeout(() => {
          pending = null
        }, 1200)
        event.preventDefault()
        return
      }
      const handler = handlers[combo]
      if (handler && available(combo)) runBinding(handler, event)
    }
    const onKey = (event: KeyboardEvent) => handleKey(event, false)
    const onMessageKey = (event: Event) => {
      if (
        event.target instanceof HTMLIFrameElement &&
        messageRoot?.current?.contains(event.target)
      ) {
        handleKey((event as CustomEvent<KeyboardEvent>).detail, true)
      }
    }
    window.addEventListener('keydown', onKey)
    if (messageRoot) window.addEventListener(messageKeydownEvent, onMessageKey)
    return () => {
      window.clearTimeout(pendingTimer)
      window.removeEventListener('keydown', onKey)
      if (messageRoot) window.removeEventListener(messageKeydownEvent, onMessageKey)
    }
  }, [enabled, messageRoot])
}
