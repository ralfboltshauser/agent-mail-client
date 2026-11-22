import { useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'

export function ReasonInput({
  label,
  initial = '',
  onSave,
  onCancel,
}: {
  label: string
  initial?: string
  onSave: (value: string) => void | Promise<void>
  onCancel: () => void
}) {
  const input = useRef<HTMLInputElement>(null)
  const submitting = useRef(false)
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)
  useEffect(() => input.current?.focus({ preventScroll: true }), [])
  return (
    <form
      data-review-reason
      className="grid min-w-0 gap-1"
      onKeyDown={(event) => {
        if (event.key !== 'Escape' || event.nativeEvent.isComposing) return
        event.stopPropagation()
        event.preventDefault()
        if (!submitting.current) onCancel()
      }}
      onSubmit={async (event) => {
        event.preventDefault()
        if (submitting.current || !input.current) return
        submitting.current = true
        setBusy(true)
        setFailed(false)
        try {
          await onSave(input.current.value.trim())
        } catch {
          setFailed(true)
        } finally {
          submitting.current = false
          setBusy(false)
        }
      }}
    >
      <label className="grid gap-1 text-sm">
        {label}
        <input
          ref={input}
          defaultValue={initial}
          maxLength={500}
          disabled={busy}
          className="min-w-0 rounded-md border bg-background px-2 py-1.5 text-base focus-visible:outline-2 focus-visible:outline-ring"
        />
      </label>
      <div className="flex gap-2">
        <Button type="submit" size="sm" disabled={busy}>
          Apply
        </Button>
        <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={onCancel}>
          Cancel
        </Button>
      </div>
      {failed && (
        <p className="text-destructive" role="alert">
          Could not save the reason. Try again.
        </p>
      )}
    </form>
  )
}
