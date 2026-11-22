import { useRef, useState } from 'react'
import { toast } from 'sonner'
import { getAmc } from '@/lib/amc'

export function useMailDialogs() {
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [shortcutsOpen, setShortcutsOpen] = useState(false)
  const [agentOpen, setAgentOpen] = useState(false)
  const [sendSettings, setSendSettings] = useState<number | null>(null)
  const openSendSettings = () => {
    void getAmc()
      .sendSettings()
      .then(({ undoSendSeconds }) => setSendSettings(undoSendSeconds))
      .catch((cause: Error) =>
        toast.error('Could not open settings', { description: cause.message }),
      )
  }
  const paletteInvoker = useRef<HTMLElement | null>(null)
  const rememberFocus = () => {
    paletteInvoker.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null
  }
  const openPalette = () => {
    rememberFocus()
    setPaletteOpen(true)
  }
  const restoreDialogFocus = (event: Event) => {
    if (paletteInvoker.current?.isConnected && document.activeElement === document.body) {
      event.preventDefault()
      paletteInvoker.current.focus()
    }
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
    restoreDialogFocus,
  }
}
