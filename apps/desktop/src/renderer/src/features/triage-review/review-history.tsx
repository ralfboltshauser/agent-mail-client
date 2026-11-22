import { FILTERED_LABEL, type Label, SCREENED_OUT_LABEL } from '@amc/protocol'
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { canUndo, statusLabel } from './journal'
import type { ReviewAction } from './model'
import { ReasonInput } from './reason-input'
import type { ReviewStore } from './store'
import { useReviewValue } from './use-review-value'

export function ReviewHistory({
  store,
  accountId,
  labels,
  onOutbox,
}: {
  store: ReviewStore
  accountId: string | null
  labels: Label[]
  onOutbox: () => void
}) {
  const history = useReviewValue(store, (view) => view.history)
  const visible = history.filter((action) => accountId === null || action.accountId === accountId)
  if (!visible.length) return null
  return (
    <details className="mt-4 text-sm">
      <summary className="cursor-pointer rounded-sm focus-visible:ring-2 focus-visible:ring-ring">
        Action history ({visible.length})
      </summary>
      <ol className="mt-2 max-h-64 divide-y overflow-y-auto rounded-md border px-3">
        {visible.toReversed().map((action) => (
          <li key={action.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
            <div>
              <p>
                {action.label} · {statusLabel(action.status)}
              </p>
              {action.error && <p className="text-destructive">{action.error}</p>}
              {action.undo && (
                <p>
                  Undo · {statusLabel(action.undo.status)} {action.undo.error}
                </p>
              )}
            </div>
            <div className="flex gap-1">
              {action.decision.kind === 'reply' && action.status !== 'undone' && (
                <Button size="sm" variant="outline" onClick={onOutbox}>
                  Open Outbox
                </Button>
              )}
              {(action.decision.kind === 'filter' ||
                (action.decision.kind === 'sender' &&
                  action.decision.input.decision === 'block')) &&
                action.undo === undefined &&
                action.error &&
                /adopt|already in use/.test(action.error) &&
                labels
                  .filter(
                    (label) =>
                      label.accountId === action.accountId &&
                      label.kind === 'user' &&
                      label.name.toLowerCase() ===
                        (action.decision.kind === 'filter'
                          ? FILTERED_LABEL
                          : SCREENED_OUT_LABEL
                        ).toLowerCase(),
                  )
                  .map((label) => (
                    <Button
                      key={label.id}
                      size="sm"
                      variant="outline"
                      onClick={() => void store.adoptDestination(action, label.providerId)}
                    >
                      Use existing {label.name}
                    </Button>
                  ))}
              {(action.status === 'unconfirmed' ||
                action.status === 'rejected' ||
                action.status === 'failed' ||
                action.status === 'partial') && (
                <Button size="sm" variant="outline" onClick={() => void store.retryAction(action)}>
                  {action.status === 'unconfirmed' ? 'Retry decision' : 'Review card'}
                </Button>
              )}
              {import.meta.env.VITE_AMC_PRIVATE_TRIAGE_REASONS !== '0' &&
                (action.decision.kind === 'filter' ||
                  (action.decision.kind === 'sender' &&
                    action.decision.input.decision === 'block')) &&
                !['unconfirmed', 'rejected'].includes(action.status) && (
                  <HistoryReason action={action} store={store} />
                )}
              {canUndo(action) && (
                <Button size="sm" variant="outline" onClick={() => void store.undoAction(action)}>
                  {action.undo ? 'Retry Undo' : 'Undo'}
                </Button>
              )}
            </div>
          </li>
        ))}
      </ol>
    </details>
  )
}

function HistoryReason({ action, store }: { action: ReviewAction; store: ReviewStore }) {
  const [editing, setEditing] = useState<{ reason: string; revision: string | null } | null>(null)
  const [error, setError] = useState(false)
  if (editing)
    return (
      <ReasonInput
        label="Action reason"
        initial={editing.reason}
        onCancel={() => setEditing(null)}
        onSave={async (value) => {
          await store.editReason(action, value, editing.revision)
          setEditing(null)
        }}
      />
    )
  return (
    <Button
      size="sm"
      variant="outline"
      aria-label={error ? 'Retry loading reason' : 'View or edit reason'}
      onClick={() => {
        setError(false)
        void store.loadReason(action).then(setEditing, () => setError(true))
      }}
    >
      {error ? 'Retry loading reason' : 'View or edit reason'}
    </Button>
  )
}
