import { useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { getAmc } from '@/lib/amc'

export function RestoreFiltered({ threadId }: { threadId: string }) {
  const smart = getAmc().smartInbox
  const [actionId, setActionId] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const sending = useRef(false)

  useEffect(() => {
    if (!actionId || !smart) return
    let active = true
    let timer: ReturnType<typeof setTimeout>
    const check = async () => {
      try {
        const result = await smart.ownerAction(actionId)
        if (!active) return
        if (result.status !== 'pending') {
          setActionId(null)
          if (result.status !== 'applied')
            setError(result.error ?? 'The Thread changed before it could be restored.')
          return
        }
      } catch {
        // Keep the queued action while the Engine reconnects.
      }
      if (active) timer = setTimeout(check, 1500)
    }
    timer = setTimeout(check, 1500)
    return () => {
      active = false
      clearTimeout(timer)
    }
  }, [actionId, smart])

  if (!smart?.restoreFiltered) return null
  const restore = async () => {
    if (sending.current || actionId) return
    sending.current = true
    setBusy(true)
    setError(null)
    try {
      const result = await smart.restoreFiltered?.(threadId, crypto.randomUUID())
      if (result?.status === 'pending') setActionId(result.actionId)
      else if (result && result.status !== 'applied')
        setError(result.error ?? 'Could not restore this Thread.')
    } catch {
      setError('Could not confirm the restore. Refresh the Thread and try again.')
    } finally {
      sending.current = false
      setBusy(false)
    }
  }
  return (
    <div className="mb-4 space-y-1">
      <Button
        size="sm"
        variant="outline"
        disabled={busy || !!actionId}
        onClick={() => void restore()}
      >
        {busy || actionId ? 'Restoring to Inbox…' : 'Not filtered — move to Inbox'}
      </Button>
      {error && (
        <p className="text-sm text-destructive" role="alert">
          {error}
        </p>
      )}
    </div>
  )
}
