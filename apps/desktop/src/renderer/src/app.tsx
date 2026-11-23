import { useCallback, useEffect } from 'react'
import { toast } from 'sonner'
import { getAmc } from '@/lib/amc'
import { copyDiagnostics } from '@/lib/diagnostics'
import { failureText } from '@/lib/failure'
import { type FailureDetails, formatFailure } from '../../shared/failure'
import { MailLoading } from './components/mail-state'
import { PairScreen } from './components/pair-screen'
import { Button } from './components/ui/button'
import { Toaster } from './components/ui/sonner'
import { TooltipProvider } from './components/ui/tooltip'
import { FeedbackEntry } from './features/feedback/feedback-entry'
import { MailWorkspace } from './features/mailbox/mail-workspace'
import { usePairingGate } from './hooks/use-amc'
import { useTheme } from './hooks/use-theme'

export function App() {
  const gate = usePairingGate()
  const { dark, setTheme } = useTheme()
  const toggleTheme = useCallback(() => setTheme(dark ? 'light' : 'dark'), [dark, setTheme])
  useEffect(() => getAmc().onCopyDiagnostics(copyDiagnostics), [])
  return (
    <TooltipProvider>
      {!gate.phase ? (
        <MailLoading label="Opening AMC" />
      ) : gate.phase === 'unpaired' ? (
        <PairScreen
          savedEngineUrl={gate.engineUrl}
          recoveryMessage={gate.error}
          failure={gate.failure}
        />
      ) : gate.phase === 'restoring-pairing' || gate.phase === 'pairing-read-error' ? (
        <SavedPairingState retrying={gate.phase === 'restoring-pairing'} failure={gate.failure} />
      ) : (
        <MailWorkspace
          key={gate.engineUrl}
          engineUrl={gate.engineUrl ?? null}
          dark={dark}
          onToggleTheme={toggleTheme}
        />
      )}
      {gate.phase && <FeedbackEntry />}
      <Toaster theme={dark ? 'dark' : 'light'} position="bottom-right" />
    </TooltipProvider>
  )
}

function SavedPairingState({ retrying, failure }: { retrying: boolean; failure?: FailureDetails }) {
  return (
    <main data-feedback-view="setup" className="grid h-screen place-items-center">
      <div className="app-drag absolute inset-x-0 top-0 h-11" />
      {retrying ? (
        <output className="text-sm text-muted-foreground">Reconnecting…</output>
      ) : (
        <div className="grid justify-items-center gap-3 px-6 text-center">
          <h1 className="text-lg font-semibold">AMC couldn't read its saved pairing</h1>
          {failure && (
            <p className="select-text text-xs text-muted-foreground">{formatFailure(failure)}</p>
          )}
          <Button
            onClick={() =>
              void getAmc()
                .retrySavedPairing()
                .catch((error: unknown) =>
                  toast.error('Could not retry pairing', { description: failureText(error) }),
                )
            }
          >
            Retry
          </Button>
        </div>
      )}
    </main>
  )
}
