import type { BucketDefinition } from '@amc/protocol'
import { useEffect, useId, useRef, useState } from 'react'
import { Button } from './ui/button'
import { Input } from './ui/input'

type Fields = Pick<BucketDefinition, 'name' | 'description' | 'automatic'>
const labels = {
  name: 'Name',
  description: 'Triage description',
  automatic: 'Automatic assignment',
}
const format = (value: string | boolean) =>
  typeof value === 'boolean' ? (value ? 'On' : 'Off') : value || 'Empty'

export function BucketForm({
  item,
  latest,
  pending,
  needsReview,
  onReview,
  onSave,
  onCancel,
}: {
  item: BucketDefinition | null
  latest: BucketDefinition | undefined
  pending: boolean
  needsReview: boolean
  onReview: () => void
  onSave: (values: Fields, changes: Partial<Fields>, requestId: string) => Promise<void>
  onCancel: () => void
}) {
  const nameId = useId()
  const [draft, setDraft] = useState<Partial<Fields>>({})
  const attempt = useRef<{ key: string; id: string } | null>(null)
  const nameRef = useRef<HTMLInputElement>(null)
  useEffect(() => nameRef.current?.focus(), [])
  const current = latest ?? item
  const name = draft.name ?? current?.name ?? ''
  const description = draft.description ?? current?.description ?? ''
  const automatic = draft.automatic ?? current?.automatic ?? false
  const conflicts =
    item && latest
      ? (Object.keys(labels) as (keyof Fields)[]).filter(
          (key) =>
            draft[key] !== undefined && draft[key] !== latest[key] && item[key] !== latest[key],
        )
      : []
  const blocked = pending || needsReview || latest?.archived

  return (
    <form
      className="grid gap-2 rounded-md border p-2"
      onSubmit={(event) => {
        event.preventDefault()
        if (blocked) return
        const values = { name: name.trim(), description: description.trim(), automatic }
        const changes = {
          ...(draft.name !== undefined ? { name: values.name } : {}),
          ...(draft.description !== undefined ? { description: values.description } : {}),
          ...(draft.automatic !== undefined ? { automatic } : {}),
        }
        const key = JSON.stringify(values)
        if (attempt.current?.key !== key) attempt.current = { key, id: crypto.randomUUID() }
        void onSave(values, changes, attempt.current.id)
      }}
    >
      <label htmlFor={nameId} className="grid gap-1 text-sm">
        Bucket name
        <Input
          id={nameId}
          ref={nameRef}
          value={name}
          maxLength={60}
          required
          disabled={pending}
          onChange={(event) => setDraft({ ...draft, name: event.target.value })}
        />
      </label>
      <label className="grid gap-1 text-sm">
        When should triage use this Bucket?
        <textarea
          className="rounded-md border bg-background px-3 py-2 text-sm"
          value={description}
          maxLength={500}
          required={automatic}
          disabled={pending}
          onChange={(event) => setDraft({ ...draft, description: event.target.value })}
        />
      </label>
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={automatic}
          disabled={pending}
          onChange={(event) => setDraft({ ...draft, automatic: event.target.checked })}
        />
        Allow automatic assignment
      </label>
      {latest?.archived ? (
        <output className="text-sm">
          This Bucket was archived while you were editing. Restore it to save these edits.
        </output>
      ) : (
        needsReview && (
          <div className="grid gap-2 text-sm">
            <output>The Bucket catalog changed while you were editing.</output>
            {latest &&
              conflicts.map((field) => (
                <div key={field} className="flex flex-wrap items-center justify-between gap-1">
                  <span className="min-w-0 break-words">
                    {labels[field]} now reads “{format(latest[field])}”.
                  </span>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      const next = { ...draft }
                      delete next[field]
                      setDraft(next)
                    }}
                  >
                    Use current {labels[field].toLowerCase()}
                  </Button>
                </div>
              ))}
            <Button type="button" size="sm" variant="outline" onClick={onReview}>
              {conflicts.length ? 'Keep my edits' : 'Continue editing'}
            </Button>
          </div>
        )
      )}
      <div className="flex gap-2">
        <Button type="submit" size="sm" disabled={blocked}>
          {pending ? 'Saving…' : item ? 'Save Bucket' : 'Create Bucket'}
        </Button>
        <Button type="button" size="sm" variant="ghost" disabled={pending} onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  )
}
