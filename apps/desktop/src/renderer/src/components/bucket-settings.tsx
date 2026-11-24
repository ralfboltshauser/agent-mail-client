import { type BucketDefinition, type BucketStorageKey, CustomBucketId } from '@amc/protocol'
import { useId, useRef, useState } from 'react'
import { bucketKey, useBucketCatalog } from '@/data/buckets'
import { getAmc } from '@/lib/amc'
import { failureText } from '@/lib/failure'
import type { AmcApi } from '../../../shared/api'
import { BucketForm } from './bucket-form'
import { Button } from './ui/button'

const bucketHints = new Set([
  'A Bucket already uses that name.',
  'The Bucket catalog changed. Reload it and retry.',
  'Describe when automatic triage should use this Bucket.',
  'The custom Bucket limit has been reached.',
  'This Bucket is archived.',
])

type Edit = Parameters<NonNullable<AmcApi['manageBuckets']>>[0]

export function BucketSettings({
  onOpen,
  onPendingChange,
}: {
  onOpen: (bucket: BucketStorageKey) => void
  onPendingChange: (pending: boolean) => void
}) {
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
    onPendingChange(true)
    setError('')
    setSaved('')
    try {
      await api.manageBuckets(edit)
      setSaved(message)
      return true
    } catch (cause) {
      const message =
        cause instanceof Error
          ? cause.message
              .replace(/^Error invoking remote method '[a-zA-Z:]+': Error: /, '')
              .split('\n')[0]
          : undefined
      setError(message && bucketHints.has(message) ? message : failureText(cause))
      return false
    } finally {
      setPending(false)
      onPendingChange(false)
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
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={pending}
                        onClick={() => onOpen(bucketKey(item))}
                      >
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
          {editing ? (
            <BucketForm
              key={editing === 'new' ? 'new' : editing.id}
              item={editing === 'new' ? null : editing}
              latest={editing === 'new' ? undefined : custom.find(({ id }) => id === editing.id)}
              pending={pending}
              needsReview={editing !== 'new' && editingRevision !== catalog.revision}
              onReview={() => setEditingRevision(catalog.revision)}
              onCancel={closeEditor}
              onSave={async (values, changes, requestId) => {
                const edit: Edit =
                  editing === 'new'
                    ? { kind: 'create', input: { ...values, requestId } }
                    : {
                        kind: 'update',
                        id: CustomBucketId.parse(editing.id),
                        input: { ...changes, expectedRevision: editingRevision },
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
