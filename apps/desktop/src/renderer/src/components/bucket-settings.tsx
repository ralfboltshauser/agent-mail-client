import { type BucketDefinition, type BucketStorageKey, CustomBucketId } from '@amc/protocol'
import { useId, useRef, useState } from 'react'
import { bucketKey, useBucketCatalog } from '@/data/buckets'
import { getAmc } from '@/lib/amc'
import { failureText } from '@/lib/failure'
import type { AmcApi } from '../../../shared/api'
import { Button } from './ui/button'
import { Input } from './ui/input'

type Edit = Parameters<NonNullable<AmcApi['manageBuckets']>>[0]

export function BucketSettings({ onOpen }: { onOpen: (bucket: BucketStorageKey) => void }) {
  const label = useId()
  const catalog = useBucketCatalog()
  const [editing, setEditing] = useState<BucketDefinition | 'new' | null>(null)
  const [editingRevision, setEditingRevision] = useState(0)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  const [saved, setSaved] = useState('')
  const addButton = useRef<HTMLButtonElement>(null)
  const opener = useRef<HTMLElement | null>(null)
  const submit = async (edit: Edit, message: string) => {
    const api = getAmc()
    if (!api.manageBuckets || pending) return false
    setPending(true)
    setError('')
    setSaved('')
    try {
      await api.manageBuckets(edit)
      setSaved(message)
      return true
    } catch (cause) {
      setError(failureText(cause))
      return false
    } finally {
      setPending(false)
    }
  }
  const closeEditor = () => {
    setEditing(null)
    const element = opener.current
    requestAnimationFrame(() => (element?.isConnected ? element : addButton.current)?.focus())
  }
  const custom = catalog?.definitions.filter((item) => !item.builtIn) ?? []
  const active = custom.filter((item) => !item.archived)
  const changeOrder = (index: number, delta: number) => {
    if (!catalog) return
    const ids = active.map(({ id }) => CustomBucketId.parse(id))
    const [item] = ids.splice(index, 1)
    if (!item) return
    ids.splice(index + delta, 0, item)
    void submit(
      { kind: 'reorder', input: { ids, expectedRevision: catalog.revision } },
      'Bucket order saved',
    )
  }

  return (
    <section aria-labelledby={label} className="grid gap-2 border-t pt-4" aria-busy={pending}>
      <h3 id={label} className="text-sm font-medium">
        Triage Buckets
      </h3>
      {catalog === undefined && <p className="text-sm text-muted-foreground">Loading Buckets…</p>}
      {catalog === null && (
        <p className="text-sm text-muted-foreground">
          Connect to an Engine that supports custom Buckets.
        </p>
      )}
      {catalog && (
        <>
          <details className="text-sm">
            <summary className="cursor-pointer">Built-in Buckets</summary>
            <ul className="mt-2 pl-4 text-muted-foreground">
              {catalog.definitions
                .filter((item) => item.builtIn)
                .map((item) => (
                  <li key={item.id}>{item.name}</li>
                ))}
            </ul>
          </details>
          {active.map((item, index) => (
            <div className="grid gap-1 rounded-md border p-2" key={item.id}>
              <span className="min-w-0 break-words text-sm font-medium">{item.name}</span>
              {item.automatic && (
                <span className="text-xs text-muted-foreground">Automatic assignment</span>
              )}
              <div className="flex flex-wrap gap-1">
                <Button
                  size="sm"
                  variant="ghost"
                  aria-label={`Edit ${item.name}`}
                  disabled={pending}
                  onClick={(event) => {
                    opener.current = event.currentTarget
                    setEditingRevision(catalog.revision)
                    setEditing(item)
                  }}
                >
                  Edit
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  aria-label={`Move ${item.name} up`}
                  disabled={pending || index === 0}
                  onClick={() => changeOrder(index, -1)}
                >
                  Up
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  aria-label={`Move ${item.name} down`}
                  disabled={pending || index === active.length - 1}
                  onClick={() => changeOrder(index, 1)}
                >
                  Down
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  aria-label={`Archive ${item.name}`}
                  disabled={pending}
                  onClick={() =>
                    void submit(
                      {
                        kind: 'update',
                        id: CustomBucketId.parse(item.id),
                        input: { archived: true, expectedRevision: catalog.revision },
                      },
                      'Bucket archived',
                    )
                  }
                >
                  Archive
                </Button>
              </div>
            </div>
          ))}
          {custom.some((item) => item.archived) && (
            <details className="text-sm">
              <summary className="cursor-pointer">Archived Buckets</summary>
              <ul className="mt-2 grid gap-1">
                {custom
                  .filter((item) => item.archived)
                  .map((item) => (
                    <li key={item.id} className="flex flex-wrap items-center gap-1">
                      <Button size="sm" variant="ghost" onClick={() => onOpen(bucketKey(item))}>
                        {item.name}
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        aria-label={`Restore ${item.name}`}
                        disabled={pending}
                        onClick={() =>
                          void submit(
                            {
                              kind: 'update',
                              id: CustomBucketId.parse(item.id),
                              input: { archived: false, expectedRevision: catalog.revision },
                            },
                            'Bucket restored',
                          )
                        }
                      >
                        Restore
                      </Button>
                    </li>
                  ))}
              </ul>
            </details>
          )}
          {editing && editing !== 'new' && editingRevision !== catalog.revision && (
            <div className="grid gap-2 text-sm">
              <output>The Bucket catalog changed while you were editing.</output>
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  const latest = custom.find(({ id }) => id === editing.id)
                  if (latest?.archived) closeEditor()
                  else setEditingRevision(catalog.revision)
                }}
              >
                Review and keep editing
              </Button>
            </div>
          )}
          {editing ? (
            <BucketForm
              key={editing === 'new' ? 'new' : editing.id}
              item={editing === 'new' ? null : editing}
              pending={pending || (editing !== 'new' && editingRevision !== catalog.revision)}
              onCancel={closeEditor}
              onSave={async (values, requestId) => {
                const edit: Edit =
                  editing === 'new'
                    ? { kind: 'create', input: { ...values, requestId } }
                    : {
                        kind: 'update',
                        id: CustomBucketId.parse(editing.id),
                        input: { ...values, expectedRevision: editingRevision },
                      }
                if (await submit(edit, editing === 'new' ? 'Bucket created' : 'Bucket saved'))
                  closeEditor()
              }}
            />
          ) : (
            <Button
              ref={addButton}
              variant="outline"
              size="sm"
              className="justify-self-start"
              disabled={pending}
              onClick={(event) => {
                opener.current = event.currentTarget
                setEditing('new')
              }}
            >
              New Bucket
            </Button>
          )}
        </>
      )}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      {saved && <output className="text-sm text-muted-foreground">{saved}</output>}
    </section>
  )
}

function BucketForm({
  item,
  pending,
  onSave,
  onCancel,
}: {
  item: BucketDefinition | null
  pending: boolean
  onSave: (
    values: { name: string; description: string; automatic: boolean },
    requestId: string,
  ) => Promise<void>
  onCancel: () => void
}) {
  const nameId = useId()
  const [name, setName] = useState(item?.name ?? '')
  const [description, setDescription] = useState(item?.description ?? '')
  const [automatic, setAutomatic] = useState(item?.automatic ?? false)
  const attempt = useRef<{ key: string; id: string } | null>(null)
  const nameRef = useRef<HTMLInputElement>(null)
  const focusName = (element: HTMLInputElement | null) => {
    if (element && element !== nameRef.current) element.focus()
    nameRef.current = element
  }
  return (
    <form
      className="grid gap-2 rounded-md border p-2"
      onSubmit={(event) => {
        event.preventDefault()
        if (pending) return
        const values = { name: name.trim(), description: description.trim(), automatic }
        const key = JSON.stringify(values)
        if (attempt.current?.key !== key) attempt.current = { key, id: crypto.randomUUID() }
        void onSave(values, attempt.current.id)
      }}
    >
      <label htmlFor={nameId} className="grid gap-1 text-sm">
        Bucket name
        <Input
          id={nameId}
          ref={focusName}
          value={name}
          maxLength={60}
          required
          disabled={pending}
          onChange={(event) => setName(event.target.value)}
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
          onChange={(event) => setDescription(event.target.value)}
        />
      </label>
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={automatic}
          disabled={pending}
          onChange={(event) => setAutomatic(event.target.checked)}
        />
        Allow automatic assignment
      </label>
      <div className="flex gap-2">
        <Button type="submit" size="sm" disabled={pending}>
          {pending ? 'Saving…' : item ? 'Save Bucket' : 'Create Bucket'}
        </Button>
        <Button type="button" size="sm" variant="ghost" disabled={pending} onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  )
}
