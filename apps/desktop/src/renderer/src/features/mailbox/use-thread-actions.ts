import type { AccountSummary, Bucket, Label, ThreadSummary } from '@amc/protocol'
import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { useOrganise } from '@/components/organise'
import { useReplica } from '@/hooks/use-amc'
import { getAmc } from '@/lib/amc'
import type { SyncPhase, ThreadWithMessages } from '../../../../shared/api'

export function useThreadActions({
  selected,
  activeThread,
  accountId,
  accounts,
  labels,
  snoozeEnabled,
  syncPhase,
}: {
  selected: ThreadSummary | undefined
  activeThread: ThreadWithMessages | null
  accountId: string | null
  accounts: AccountSummary[]
  labels: Label[]
  snoozeEnabled: boolean
  syncPhase: SyncPhase
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
  const handoff = useReplica(
    async () =>
      selectedId
        ? {
            threadId: selectedId,
            accountId: selected.accountId,
            active: await getAmc().activeHandoff(selectedId),
          }
        : null,
    [selectedId, selected?.accountId, syncPhase],
    null,
  )
  const [inactiveHandoff, setInactiveHandoff] = useState<string | null>(null)
  const [endingHandoff, setEndingHandoff] = useState<string | null>(null)
  const activeHandoff =
    handoff &&
    handoff.threadId === selectedId &&
    handoff.accountId === selected?.accountId &&
    handoff.active?.id !== inactiveHandoff
      ? handoff.active
      : null
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
  const canOrganise =
    canUndoOrganise &&
    activeThread !== null &&
    activeThread.messages.length === activeThread.thread.messageCount
  const organise = useOrganise(
    canOrganise ? (activeThread?.thread ?? null) : null,
    snoozeEnabled,
    organiseAccount,
    labels,
  )
  const organisePicker =
    canOrganise && organise.picker?.thread.id === activeThread?.thread.id ? organise.picker : null

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
