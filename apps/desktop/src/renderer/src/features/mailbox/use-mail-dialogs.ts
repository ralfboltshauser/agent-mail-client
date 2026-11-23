import { useEffect, useEffectEvent, useRef, useState } from 'react'
import { toast } from 'sonner'
import { getAmc } from '@/lib/amc'
import { failureText } from '@/lib/failure'

function focusedElement() {
  return document.activeElement instanceof HTMLElement ? document.activeElement : null
}

function restoreFocus(event: Event, invoker: HTMLElement | null) {
  if (invoker?.isConnected && document.activeElement === document.body) {
    event.preventDefault()
    invoker.focus()
  }
}

export function useMailDialogs() {
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [shortcutsOpen, setShortcutsOpen] = useState(false)
  const [agentOpen, setAgentOpen] = useState(false)
  const [sendSettings, setSendSettings] = useState<number | null>(null)
  const paletteInvoker = useRef<HTMLElement | null>(null)
  const settingsInvoker = useRef<HTMLElement | null>(null)
  const openSendSettings = () => {
    if (sendSettings !== null) return
    settingsInvoker.current = paletteOpen ? paletteInvoker.current : focusedElement()
    void getAmc()
      .sendSettings()
      .then(({ undoSendSeconds }) => setSendSettings(undoSendSeconds))
      .catch((cause: Error) =>
        toast.error('Could not open settings', { description: failureText(cause) }),
      )
  }
  const rememberFocus = () => {
    paletteInvoker.current = focusedElement()
  }
  const openSettingsFromMenu = useEffectEvent(openSendSettings)
  // biome-ignore lint/correctness/useExhaustiveDependencies: React Effect Events are intentionally excluded from effect dependencies.
  useEffect(() => getAmc().onOpenSettings(() => openSettingsFromMenu()), [])

  const openPalette = () => {
    rememberFocus()
    setPaletteOpen(true)
  }

  return {
    paletteOpen,
    setPaletteOpen,
    shortcutsOpen,
    setShortcutsOpen,
    agentOpen,
    setAgentOpen,
    sendSettings,
    setSendSettings,
    openSendSettings,
    paletteInvoker,
    rememberFocus,
    openPalette,
    restoreDialogFocus: (event: Event) => restoreFocus(event, paletteInvoker.current),
    restoreSettingsFocus: (event: Event) => restoreFocus(event, settingsInvoker.current),
  }
}
