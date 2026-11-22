import { useSyncExternalStore } from 'react'
import type { DraftSession } from './draft-session'

export function useDraftValue<T>(session: DraftSession, select: (session: DraftSession) => T) {
  return useSyncExternalStore(session.subscribe, () => select(session))
}
