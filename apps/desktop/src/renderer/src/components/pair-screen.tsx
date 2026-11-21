import { Loader2 } from 'lucide-react'
import { useId, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

/** First run: connect this Mac to the Engine with a one-time code from the Host. */
export function PairScreen({
  savedEngineUrl,
  recoveryMessage,
}: {
  savedEngineUrl: string | null
  recoveryMessage: string | null
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
      await window.amc.pair(engineUrl.trim(), code.trim())
    } catch (e) {
      setError(
        (e as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ''),
      )
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex h-full flex-col">
      <div className="app-drag h-10 shrink-0" />
      <div className="flex flex-1 items-center justify-center p-8">
        <form onSubmit={submit} className="w-full max-w-sm space-y-6">
          <div className="space-y-1.5">
            <h1 className="text-2xl font-semibold tracking-tight">Connect to your Engine</h1>
            {recoveryMessage ? (
              <p role="alert" className="text-sm text-destructive">
                {recoveryMessage}
              </p>
            ) : (
              <p className="text-sm text-muted-foreground">
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
              <span className="text-xs font-medium text-muted-foreground">Engine URL</span>
              <Input
                id={urlId}
                value={engineUrl}
                onChange={(e) => setEngineUrl(e.target.value)}
                placeholder="https://host.tailnet.ts.net:4443"
                autoFocus
              />
            </label>
            <label htmlFor={codeId} className="block space-y-1.5">
              <span className="text-xs font-medium text-muted-foreground">Pairing code</span>
              <Input
                id={codeId}
                value={code}
                onChange={(e) => setCode(e.target.value.toUpperCase())}
                placeholder="ABCD-EFGH"
                className="font-mono tracking-widest"
              />
            </label>
          </div>
          {error && <p className="text-sm text-destructive">{error}</p>}
          <Button
            type="submit"
            className="w-full"
            disabled={busy || code.length < 8 || engineUrl.length < 10}
          >
            {busy && <Loader2 className="animate-spin" />}
            Connect
          </Button>
        </form>
      </div>
    </div>
  )
}
