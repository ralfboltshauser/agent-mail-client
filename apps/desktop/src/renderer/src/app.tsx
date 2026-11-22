import { useCallback } from 'react'
import { getAmc } from '@/lib/amc'
import { MailLoading } from './components/mail-state'
import { PairScreen } from './components/pair-screen'
import { Button } from './components/ui/button'
import { Toaster } from './components/ui/sonner'
import { TooltipProvider } from './components/ui/tooltip'
import { MailWorkspace } from './features/mailbox/mail-workspace'
import { useSyncStatus } from './hooks/use-amc'
import { useTheme } from './hooks/use-theme'

export function App() {
  const status = useSyncStatus()
  const { dark, setTheme } = useTheme()
  const toggleTheme = useCallback(() => setTheme(dark ? 'light' : 'dark'), [dark, setTheme])
  if (!status) return <MailLoading label="Opening AMC" />
  return (
    <TooltipProvider delayDuration={400}>
      {status.phase === 'unpaired' ? (
        <PairScreen savedEngineUrl={status.engineUrl} recoveryMessage={status.error} />
      ) : status.phase === 'restoring-pairing' || status.phase === 'pairing-read-error' ? (
        <SavedPairingState retrying={status.phase === 'restoring-pairing'} />
      ) : (
        <MailWorkspace
          key={status.engineUrl}
          status={status}
          dark={dark}
          onToggleTheme={toggleTheme}
        />
      )}
      <Toaster theme={dark ? 'dark' : 'light'} position="bottom-center" />
    </TooltipProvider>
  )
}

function SavedPairingState({ retrying }: { retrying: boolean }) {
  return (
    <main className="grid h-screen place-items-center">
      <div className="app-drag absolute inset-x-0 top-0 h-11" />
      {retrying ? (
        <output className="text-sm text-muted-foreground">Reconnecting…</output>
      ) : (
        <div className="grid justify-items-center gap-3 px-6 text-center">
          <h1 className="text-lg font-semibold">AMC couldn't read its saved pairing</h1>
          <Button onClick={() => void getAmc().retrySavedPairing()}>Retry</Button>
        </div>
      )}
    </main>
  )
}
