import { BUCKETS, type Bucket } from '@amc/protocol'
import { useState } from 'react'
import { toast } from 'sonner'
import { failureText } from '@/lib/failure'
import { defaultTriageColors, readTriageColor, saveTriageColor, triageColors } from './preferences'
import { TriageBadge } from './triage-badge'

export function TriageColorSettings() {
  return (
    <section aria-label="Triage badge colors" className="grid gap-2 border-t pt-4">
      <h3 className="text-sm font-medium">Triage badge colors</h3>
      <p className="text-xs text-muted-foreground">Changes save on this Mac.</p>
      {BUCKETS.map((bucket) => (
        <TriageColorPicker key={bucket} bucket={bucket} />
      ))}
    </section>
  )
}

function TriageColorPicker({ bucket }: { bucket: Bucket }) {
  const [choice, setChoice] = useState(() => readTriageColor(bucket))
  return (
    <label className="flex items-center justify-between gap-2">
      <TriageBadge bucket={bucket}>{bucket}</TriageBadge>
      <select
        aria-label={`${bucket} color`}
        className="h-8 w-36 shrink-0 rounded-md border border-input bg-background px-2 text-xs focus-visible:outline-2 focus-visible:outline-ring"
        value={choice}
        onChange={(event) => {
          const next = triageColors.find((color) => color === event.target.value) ?? 'Default'
          try {
            saveTriageColor(bucket, next)
            setChoice(next)
          } catch (error) {
            toast.error('Could not save triage badge color', { description: failureText(error) })
          }
        }}
      >
        <option value="Default">Default ({defaultTriageColors[bucket]})</option>
        {triageColors.map((color) => (
          <option key={color}>{color}</option>
        ))}
      </select>
    </label>
  )
}
