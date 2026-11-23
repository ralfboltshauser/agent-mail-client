import type { Label, ThreadSummary } from '@amc/protocol'
import { FilterX, Inbox } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { getAmc } from '@/lib/amc'
import { failureText, recordCaughtFailure } from '@/lib/failure'
import { reviewError } from '../triage-review/model'
import type { MailboxAccount } from './mailbox-queries'

const filter = {
  name: 'Filter out',
  shortcut: '!',
  icon: FilterX,
  queued: 'Filter out queued',
  applied: 'Filtered out',
  failed: 'Could not filter out this Thread',
}
const restore = {
  name: 'Restore to Inbox',
  shortcut: undefined,
  icon: Inbox,
  queued: 'Restore queued',
  applied: 'Restored to Inbox',
  failed: 'Could not restore this Thread',
}

type Move = typeof filter | typeof restore
type Pending = { move: Move; actionId?: string }
export type FilterAction = Pick<Move, 'name' | 'shortcut' | 'icon'> & {
  disabled: boolean
  run: () => void
}

export function useFilterActions(accounts: MailboxAccount[], labels: Label[]) {
  const smart = getAmc().smartInbox
  const sending = useRef(new Set<string>())
  const [pending, setPending] = useState<ReadonlyMap<string, Pending>>(new Map())
  const finish = useCallback((threadId: string) => {
    sending.current.delete(threadId)
    setPending((current) => {
      const next = new Map(current)
      next.delete(threadId)
      return next
    })
  }, [])

  useEffect(() => {
    if (!smart || ![...pending.values()].some(({ actionId }) => actionId)) return
    let active = true
    const poll = async () => {
      await Promise.all(
        [...pending].map(async ([threadId, { actionId, move }]) => {
          if (!actionId) return
          try {
            const { status, error } = await smart.ownerAction(actionId)
            if (!active || status === 'pending') return
            finish(threadId)
            if (status === 'applied') toast(move.applied, { id: actionId })
            else toast.error(error ?? move.failed, { id: actionId })
          } catch (error) {
            recordCaughtFailure(error)
            // The Engine can be temporarily unreachable while a queued move settles.
          }
        }),
      )
      if (active) timer = setTimeout(poll, 1500)
    }
    let timer = setTimeout(poll, 1500)
    return () => {
      active = false
      clearTimeout(timer)
    }
  }, [finish, pending, smart])

  const run = async (
    threadId: string,
    move: Move,
    submit: NonNullable<NonNullable<typeof smart>['filterThread']>,
  ) => {
    if (!smart || sending.current.has(threadId)) return
    sending.current.add(threadId)
    setPending((current) => new Map(current).set(threadId, { move }))
    try {
      const result = await submit(threadId, crypto.randomUUID())
      const { status, actionId } = result
      if (status !== 'pending') finish(threadId)
      if (status !== 'pending' && status !== 'applied') {
        toast.error(result.error ?? move.failed)
        return
      }
      if (status === 'pending')
        setPending((current) => new Map(current).set(threadId, { move, actionId }))
      toast(status === 'pending' ? move.queued : move.applied, {
        id: actionId,
        action: {
          label: 'Undo',
          onClick: () => {
            void smart.undoOwnerAction(actionId).then(
              ({ undo }) => {
                if (undo?.status === 'applied') toast('Move undone', { id: actionId })
                else if (undo?.status === 'pending') toast('Undo queued', { id: actionId })
                else toast.error(undo?.error ?? 'Could not undo this move')
              },
              (error: unknown) =>
                toast.error('Could not confirm Undo', { description: failureText(error) }),
            )
          },
        },
      })
    } catch (error) {
      finish(threadId)
      toast.error(move.failed, { description: reviewError(error) })
    }
  }

  return (thread: ThreadSummary): FilterAction[] => {
    const account = accounts.find(({ id }) => id === thread.accountId)
    if (!account || account.imapMoves === false) return []
    const disabled = pending.has(thread.id)
    const actions: FilterAction[] = []
    const filterThread = smart?.filterThread
    const restoreFiltered = smart?.restoreFiltered
    if (filterThread && thread.inInbox) {
      actions.push({ ...filter, disabled, run: () => void run(thread.id, filter, filterThread) })
    }
    if (
      restoreFiltered &&
      labels.some(({ id, managed }) => managed === 'filtered' && thread.labelIds.includes(id))
    ) {
      actions.push({
        ...restore,
        disabled,
        run: () => void run(thread.id, restore, restoreFiltered),
      })
    }
    return actions
  }
}
