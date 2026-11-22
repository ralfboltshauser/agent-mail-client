import { useMemo, useState } from 'react'
import { useReplicaQuery } from '@/hooks/use-amc'

type Result<T> = { data: T } | { failed: true }

/** Associate the legacy hook's retained value with the read that produced it. */
export function useMailboxQuery<T>(key: string, load: () => Promise<T>, enabled = true) {
  const scope = useMemo(() => ({ key, enabled }), [key, enabled])
  const query = useReplicaQuery(
    async () => {
      if (!scope.enabled) return null
      let result: Result<T>
      try {
        result = { data: await load() }
      } catch {
        result = { failed: true }
      }
      return { scope, result }
    },
    [scope],
    null,
    // The caller pauses reads and retains accepted data while a snapshot is pending.
    { preserveOnBootstrap: false },
  )
  const reply = query.value?.scope === scope ? query.value : null
  const [accepted, setAccepted] = useState<{
    key: string
    reply: typeof reply
    data: T | undefined
    failed: boolean
  }>({ key, reply: null, data: undefined, failed: false })

  // Retain same-key data across refreshes, including a paused snapshot read.
  // Adjust during render so a different key never paints a retained frame.
  let current = accepted
  if (key !== accepted.key || (reply && reply !== accepted.reply)) {
    current = {
      key,
      reply,
      data:
        reply && 'data' in reply.result
          ? reply.result.data
          : key === accepted.key
            ? accepted.data
            : undefined,
      failed: Boolean(reply && 'failed' in reply.result),
    }
    setAccepted(current)
  }
  return { data: current.data, failed: current.failed, refresh: query.refresh }
}
