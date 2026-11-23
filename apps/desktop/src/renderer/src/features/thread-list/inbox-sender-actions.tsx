import type { OwnerActionStatus, SenderDecision } from '@amc/protocol'
import { memo, useRef, useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { accountsQuery, type MailboxThreadQuery } from '@/features/mailbox/mailbox-queries'
import { reviewError } from '@/features/triage-review/model'
import { useReplicaSelector } from '@/hooks/use-amc'
import { getAmc } from '@/lib/amc'
import { cn } from '@/lib/utils'

type Decision = 'accept' | 'block'
const decisions = { accept: 'Accept', block: 'Block' } as const

export const InboxSenderActions = memo(function InboxSenderActions({
  id,
  query,
  selected,
  start,
  onFocusChange,
  returnFocus,
}: {
  id: string
  query: MailboxThreadQuery
  selected: boolean
  start: number
  onFocusChange: (id: string | null) => void
  returnFocus: () => void
}) {
  const sender = useReplicaSelector(query, ({ data }) => {
    const card = data?.inbox?.cards.get(id)
    return card && data?.summaries.get(card.representativeId)?.inboxSender
  })
  const canBlock = useReplicaSelector(accountsQuery(), ({ data }) =>
    data?.some((account) => account.id === sender?.accountId && account.imapMoves !== false),
  )
  const inFlight = useRef(false)
  const retry = useRef<SenderDecision | null>(null)
  const [busy, setBusy] = useState(false)
  const smart = getAmc().smartInbox
  if (!sender || !smart) return null

  const run = async (decision: Decision) => {
    if (inFlight.current || (decision === 'block' && !canBlock)) return
    const previous = retry.current
    const input: SenderDecision = {
      accountId: sender.accountId,
      address: sender.address,
      expectedRevision: sender.revision,
      clientActionId:
        previous?.decision === decision && previous.expectedRevision === sender.revision
          ? previous.clientActionId
          : crypto.randomUUID(),
      decision,
      source: 'thread-action',
    }
    inFlight.current = true
    retry.current = input
    returnFocus()
    setBusy(true)
    try {
      const result = await smart.decideSender(input)
      retry.current = null
      const { actionId } = result
      const applied = decision === 'accept' ? 'Sender accepted' : 'Sender blocked'
      const failed = `Could not ${decision} sender`
      let undoing = false
      const report = ({ status, error }: OwnerActionStatus) => {
        if (status !== 'pending' && status !== 'applied') {
          toast.error(error ?? failed, { id: actionId })
          return
        }
        toast(status === 'pending' ? `${decisions[decision]} sender queued` : applied, {
          id: actionId,
          action: {
            label: 'Undo',
            onClick: () => {
              undoing = true
              void smart.undoOwnerAction(actionId).then(
                ({ undo }) => {
                  if (undo?.status === 'applied') toast('Sender decision undone', { id: actionId })
                  else if (undo?.status === 'pending') toast('Undo queued', { id: actionId })
                  else
                    toast.error(undo?.error ?? 'Could not undo sender decision', { id: actionId })
                },
                () => toast.error('Could not confirm Undo', { id: actionId }),
              )
            },
          },
        })
      }
      report(result)
      // An accepted Block can leave the list while its provider moves are still queued.
      if (result.status === 'pending') {
        for (let attempt = 0; attempt < 20 && !undoing; attempt++) {
          await new Promise((resolve) => setTimeout(resolve, 1500))
          if (undoing) break
          const status = await smart.ownerAction(actionId).catch(() => null)
          if (!status || status.status === 'pending' || undoing) continue
          report(status)
          break
        }
      }
    } catch (error) {
      toast.error('Could not confirm sender decision', { description: reviewError(error) })
    } finally {
      inFlight.current = false
      setBusy(false)
    }
  }

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: Pin the virtual row while a native button has focus.
    <div
      className={cn(
        'pointer-events-none absolute right-3 flex gap-1',
        !selected && 'invisible group-hover:visible group-focus-within:visible',
      )}
      style={{ top: start + 52 }}
      onFocus={() => onFocusChange(`sender:${id}`)}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) onFocusChange(null)
      }}
    >
      {(['accept', 'block'] as const).map((decision) => (
        <Button
          key={decision}
          type="button"
          size="xs"
          variant="outline"
          className="pointer-events-auto aria-disabled:opacity-50"
          tabIndex={selected ? 0 : -1}
          aria-disabled={busy || (decision === 'block' && !canBlock)}
          onClick={() => void run(decision)}
        >
          {decisions[decision]}
        </Button>
      ))}
    </div>
  )
})
