import { useEffect, useState } from 'react'
import { getAmc } from '@/lib/amc'
import { failureText } from '@/lib/failure'
import type { DesktopLogSettings } from '../../../shared/api'

export function DebugLoggingSetting() {
  const { logSettings, setDebugLogging } = getAmc()
  const [settings, setSettings] = useState<DesktopLogSettings>()
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string>()
  useEffect(() => {
    if (!logSettings) return
    let current = true
    void logSettings().then(
      (value) => {
        if (current) setSettings(value)
      },
      (cause: unknown) => {
        if (current) setError(failureText(cause))
      },
    )
    return () => {
      current = false
    }
  }, [logSettings])

  if (!logSettings || !setDebugLogging) return null
  return (
    <section className="grid gap-1 border-t pt-4" aria-label="Diagnostics">
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={settings?.debug ?? false}
          disabled={!settings || saving}
          onChange={(event) => {
            setSaving(true)
            setError(undefined)
            void setDebugLogging(event.target.checked)
              .then(setSettings)
              .catch((cause: unknown) => setError(failureText(cause)))
              .finally(() => setSaving(false))
          }}
        />
        Debug logging
      </label>
      {settings && (
        <p className="text-xs text-muted-foreground">
          Active log level · {settings.effectiveLevel}
        </p>
      )}
      {error && (
        <p className="text-xs text-destructive select-text" role="alert">
          {error}
        </p>
      )}
    </section>
  )
}
