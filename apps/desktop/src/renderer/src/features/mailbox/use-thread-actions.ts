import type { Bucket, Label, ThreadSummary } from '@amc/protocol'
import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { useOrganise } from '@/components/organise'
import { useReplicaSelector, useSyncField } from '@/hooks/use-amc'
import { getAmc } from '@/lib/amc'
import type { MailboxAccount } from './mailbox-queries'

export function useThreadActions({
  selected,
  activeThread,
  complete,
  accountId,
  accounts,
  labels,
  snoozeEnabled,
}: {
  selected: ThreadSummary | undefined
  activeThread: ThreadSummary | null
  complete: boolean
  accountId: string | null
  accounts: MailboxAccount[]
  labels: Label[]
  snoozeEnabled: boolean
}) {
  const selectedId = selected?.id
  const [bucketPickerId, setBucketPickerId] = useState<string | null>(null)
  const bucketPickerOpen = !!selected && bucketPickerId === selected.id
  const setBucket = async (bucket: Bucket | null) => {
    if (!selected || (selected.bucket?.bucket ?? null) === bucket) return
    setBucketPickerId(null)
    try {
      await getAmc().setBucket({ threadId: selected.id, bucket, reason: 'Set manually' })
    } catch (error) {
      toast.error('Could not move Thread', { description: (error as Error).message })
    }
  }
  const phase = useSyncField((status) => status?.phase)
  const handoff = useReplicaSelector(
    selectedId
      ? {
          key: JSON.stringify(['active-handoff', selected.accountId, selectedId, phase]),
          load: () => getAmc().activeHandoff(selectedId),
        }
      : null,
    ({ data }) => data,
  )
  const [inactiveHandoff, setInactiveHandoff] = useState<string | null>(null)
  const [endingHandoff, setEndingHandoff] = useState<string | null>(null)
  const activeHandoff = handoff && handoff.id !== inactiveHandoff ? handoff : null
  useEffect(() => {
    if (!activeHandoff) return
    const timer = setTimeout(
      () => setInactiveHandoff(activeHandoff.id),
      activeHandoff.expiresAt - Date.now(),
    )
    return () => clearTimeout(timer)
  }, [activeHandoff])
  const endHandoff = async (id: string) => {
    setEndingHandoff(id)
    try {
      await getAmc().endHandoff(id)
      setInactiveHandoff(id)
      toast.success('Hand-off ended')
    } catch (error) {
      toast.error('Could not end hand-off', { description: (error as Error).message })
    } finally {
      setEndingHandoff(null)
    }
  }
  const organiseAccountId = selected?.accountId ?? accountId
  const organiseAccount = accounts.find((account) => account.id === organiseAccountId)
  const canUndoOrganise = organiseAccountId ? Boolean(organiseAccount) : accounts.length > 0
  const canOrganise = canUndoOrganise && activeThread !== null && complete
  const organise = useOrganise(
    canOrganise ? activeThread : null,
    snoozeEnabled,
    organiseAccount,
    labels,
  )
  const organisePicker =
    canOrganise && organise.picker?.thread.id === activeThread?.id ? organise.picker : null

  return {
    bucketPickerOpen,
    setBucketPickerId,
    setBucket,
    activeHandoff,
    endingHandoff,
    endHandoff,
    organise,
    organiseAccount,
    canUndoOrganise,
    organisePicker,
  }
}
