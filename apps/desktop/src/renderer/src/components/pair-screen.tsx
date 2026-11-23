import { CircleAlert, Loader2, Mail } from 'lucide-react'
import { useId, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { getAmc } from '@/lib/amc'
import { failureText } from '@/lib/failure'
import { type FailureDetails, formatFailure } from '../../../shared/failure'

/** First run: connect this Mac to the Engine with a one-time code from the Host. */
export function PairScreen({
  savedEngineUrl,
  recoveryMessage,
  failure,
}: {
  savedEngineUrl: string | null
  recoveryMessage: string | null
  failure?: FailureDetails
}) {
  const urlId = useId()
  const codeId = useId()
  const [engineUrl, setEngineUrl] = useState(savedEngineUrl ?? 'https://')
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const submit = async (event: React.FormEvent) => {
    event.preventDefault()
    setBusy(true)
    setError(null)
    try {
      await getAmc().pair(engineUrl.trim(), code.trim())
    } catch (e) {
      setError(failureText(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div data-feedback-view="setup" className="flex h-full flex-col">
      <div className="app-drag h-10 shrink-0" />
      <div className="flex flex-1 items-center justify-center p-8">
        <form
          onSubmit={submit}
          className="w-full max-w-[25rem] space-y-6 rounded-xl border bg-card p-7 shadow-sm"
        >
          <div className="space-y-2.5">
            <span className="mail-state-icon mb-1 bg-accent text-primary">
              <Mail size={20} aria-hidden />
            </span>
            <h1 className="text-[23px] leading-tight font-semibold tracking-tight">
              Connect to your Engine
            </h1>
            {recoveryMessage ? (
              <p role="alert" className="text-sm text-destructive">
                {recoveryMessage}
                {failure && (
                  <span className="mt-1 block select-text text-xs">{formatFailure(failure)}</span>
                )}
              </p>
            ) : (
              <p className="text-sm leading-relaxed text-muted-foreground">
                On your Host, run{' '}
                <code className="rounded bg-muted px-1 py-0.5 text-xs">
                  sudo amc-engine pair --desktop
                </code>{' '}
                and enter the code here.
              </p>
            )}
          </div>
          <div className="space-y-3">
            <label htmlFor={urlId} className="block space-y-1.5">
              <span className="text-xs font-medium text-foreground">Engine URL</span>
              <Input
                id={urlId}
                value={engineUrl}
                onChange={(e) => setEngineUrl(e.target.value)}
                placeholder="https://host.tailnet.ts.net:4443"
                autoFocus
              />
            </label>
            <label htmlFor={codeId} className="block space-y-1.5">
              <span className="text-xs font-medium text-foreground">Pairing code</span>
              <Input
                id={codeId}
                value={code}
                onChange={(e) => setCode(e.target.value.toUpperCase())}
                placeholder="ABCD-EFGH"
                className="font-mono tracking-widest"
              />
            </label>
          </div>
          {error && (
            <p
              role="alert"
              className="flex items-start gap-2 rounded-md bg-destructive/10 p-2.5 text-sm text-destructive"
            >
              <CircleAlert className="mt-0.5 size-4 shrink-0" />
              <span>
                Could not connect.<span className="mt-1 block select-text text-xs">{error}</span>
              </span>
            </p>
          )}
          <Button
            type="submit"
            className="w-full"
            disabled={busy || code.length < 8 || engineUrl.length < 10}
          >
            {busy && <Loader2 className="motion-safe:animate-spin" />}
            Connect
          </Button>
        </form>
      </div>
    </div>
  )
}
