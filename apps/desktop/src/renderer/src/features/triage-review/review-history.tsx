import { Button } from '@/components/ui/button'
import { canUndo, statusLabel } from './journal'
import type { ReviewStore } from './store'
import { useReviewValue } from './use-review-value'

export function ReviewHistory({
  store,
  accountId,
}: {
  store: ReviewStore
  accountId: string | null
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
              {(action.status === 'unconfirmed' ||
                action.status === 'failed' ||
                action.status === 'partial') && (
                <Button size="sm" variant="outline" onClick={() => void store.retryAction(action)}>
                  {action.status === 'unconfirmed' ? 'Retry decision' : 'Review card'}
                </Button>
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
