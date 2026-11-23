import type { TriageHistoryEvent, TriageHistoryPage, TriagePhysicalPurge } from '@amc/protocol'
import { useState } from 'react'
import { ReasonInput } from '@/features/triage-review/reason-input'
import { getAmc } from '@/lib/amc'
import { failureText } from '@/lib/failure'
import { Button } from './ui/button'

export function TriagePrivacy() {
  const [historyOpen, setHistoryOpen] = useState(false)
  const [includeReasons, setIncludeReasons] = useState(false)
  const [exporting, setExporting] = useState(false)
  const [status, setStatus] = useState('')
  const api = getAmc().smartInbox
  if (!api?.exportTriageHistory || !api.triageHistory) return null
  const exportHistory = api.exportTriageHistory
  return (
    <div className="grid gap-2 border-t pt-3">
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={includeReasons}
          disabled={exporting}
          onChange={(event) => setIncludeReasons(event.target.checked)}
        />
        Include private reasons in this export
      </label>
      <p className="text-xs text-muted-foreground">
        Exports can identify your interests. Choose a private location for the file.
      </p>
      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          variant="outline"
          disabled={exporting}
          onClick={async () => {
            setExporting(true)
            setStatus('')
            try {
              if (await exportHistory({ includeReasons })) setStatus('Triage export saved.')
            } catch (error) {
              setStatus(`Could not export. ${failureText(error)}`)
            } finally {
              setIncludeReasons(false)
              setExporting(false)
            }
          }}
        >
          {exporting ? 'Exporting…' : 'Export triage history'}
        </Button>
        <Button
          size="sm"
          variant="outline"
          aria-expanded={historyOpen}
          onClick={() => setHistoryOpen((open) => !open)}
        >
          {historyOpen ? 'Close action history' : 'View or forget decisions'}
        </Button>
      </div>
      {status && <output className="text-sm">{status}</output>}
      {historyOpen && <ActionHistory />}
    </div>
  )
}

function ActionHistory() {
  const [page, setPage] = useState<TriageHistoryPage>()
  const [lastForget, setLastForget] = useState<TriagePhysicalPurge>()
  const physicalPurge = page?.physicalPurge ?? lastForget
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [selection, setSelection] = useState<{ id: string; mode: 'edit' | 'forget' }>()
  const api = getAmc().smartInbox
  const load = async (before?: number) => {
    if (!api?.triageHistory) throw new Error('History unavailable')
    setPage(await api.triageHistory({ before, includeReasons: '1' }))
  }

  async function update(work: () => Promise<void>) {
    setBusy(true)
    setError('')
    try {
      await work()
    } catch (cause) {
      setError(`Could not complete the history request. Try again. ${failureText(cause)}`)
    } finally {
      setBusy(false)
    }
  }

  function edit(event: TriageHistoryEvent, value: string) {
    if (!api?.editOwnerReason || !event.actionId) throw new Error('Reason editing unavailable')
    return api
      .editOwnerReason(event.actionId, {
        editId: crypto.randomUUID(),
        expectedReasonRevision: event.reasonRevision ?? null,
        reason: value || null,
      })
      .then(({ reason, reasonRevision }) => {
        setPage(
          (current) =>
            current && {
              ...current,
              events: current.events.map((item) =>
                item.actionId === event.actionId && item.kind === 'decision'
                  ? { ...item, reason, reasonRevision }
                  : item,
              ),
            },
        )
        setSelection(undefined)
      })
  }

  return (
    <section aria-label="Action history" className="grid gap-2">
      <h4 className="text-sm font-medium">Action history</h4>
      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          variant="outline"
          disabled={busy || !!selection}
          onClick={() => void update(() => load())}
        >
          {page ? 'Refresh history' : 'Load private history'}
        </Button>
        {page?.before && (
          <Button
            size="sm"
            variant="outline"
            disabled={busy || !!selection}
            onClick={() => void update(() => load(page.before ?? undefined))}
          >
            Older events
          </Button>
        )}
      </div>
      {physicalPurge && (
        <output className="text-sm">
          {physicalPurge === 'pending'
            ? 'Forget done. Physical purge pending. Refresh history to check again.'
            : 'Forget done. Physical purge completed.'}
        </output>
      )}
      {page && (
        <>
          {(!page.legacy.complete || page.legacy.skipped > 0) && (
            <p className="text-xs text-muted-foreground">
              {page.legacy.complete ? 'Legacy import complete.' : 'Legacy import in progress.'}{' '}
              {page.legacy.skipped} legacy actions could not be decoded.
            </p>
          )}
          {page.events.length === 0 && <p className="text-sm">No triage events on this page.</p>}
          <ol className="max-h-72 divide-y overflow-y-auto rounded-md border px-3 text-sm">
            {page.events.map((event) => (
              <li key={event.id} className="grid gap-1 py-2">
                <p>
                  {event.labelId ?? event.kind} · {event.retracted ? 'Undone' : event.source}
                </p>
                <time dateTime={event.at} className="text-xs text-muted-foreground">
                  {new Date(event.at).toLocaleString()}
                </time>
                {event.reason && <p className="break-words">{event.reason}</p>}
                {event.kind === 'decision' && (
                  <div className="flex gap-2">
                    {event.reasonEditable && (
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={busy || !!selection}
                        onClick={() => setSelection({ id: event.id, mode: 'edit' })}
                      >
                        {event.reason ? 'Edit reason' : 'Add reason'}
                      </Button>
                    )}
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={busy || !!selection}
                      onClick={() => setSelection({ id: event.id, mode: 'forget' })}
                    >
                      Forget
                    </Button>
                  </div>
                )}
                {selection?.id === event.id && selection.mode === 'edit' && (
                  <ReasonInput
                    label="Action reason"
                    initial={event.reason ?? ''}
                    onCancel={() => setSelection(undefined)}
                    onSave={(value) => edit(event, value)}
                  />
                )}
                {selection?.id === event.id && selection.mode === 'forget' && (
                  <div className="grid gap-2">
                    <p>
                      Erase this decision and any shared reason? Existing backups and exports can
                      still contain them.
                    </p>
                    <div className="flex gap-2">
                      <Button
                        size="sm"
                        variant="destructive"
                        disabled={busy}
                        onClick={() =>
                          void update(async () => {
                            if (!api?.forgetTriageDecision) throw new Error('Erasure unavailable')
                            const result = await api.forgetTriageDecision(event.id)
                            setLastForget(result?.physicalPurge)
                            setPage(undefined)
                            setSelection(undefined)
                            await load()
                          })
                        }
                      >
                        Forget decision
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={busy}
                        onClick={() => setSelection(undefined)}
                      >
                        Cancel
                      </Button>
                    </div>
                  </div>
                )}
              </li>
            ))}
          </ol>
        </>
      )}
      {busy && <output>Working…</output>}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </section>
  )
}
