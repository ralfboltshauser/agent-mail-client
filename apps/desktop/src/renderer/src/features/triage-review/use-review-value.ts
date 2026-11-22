import { useSyncExternalStore } from 'react'
import type { ReviewStore } from './store'

export function useReviewValue<T>(store: ReviewStore, select: (view: ReviewStore['view']) => T) {
  return useSyncExternalStore(store.subscribe, () => select(store.read()))
}
