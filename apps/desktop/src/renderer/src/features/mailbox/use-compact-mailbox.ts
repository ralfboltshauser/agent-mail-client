import { useSyncExternalStore } from 'react'

// Below 1000px the sidebar and default split leave less than 470px for the reader.
const COMPACT_QUERY = '(width < 1000px)'

function subscribe(onChange: () => void) {
  const media = window.matchMedia(COMPACT_QUERY)
  media.addEventListener('change', onChange)
  return () => media.removeEventListener('change', onChange)
}

function getSnapshot() {
  return window.matchMedia(COMPACT_QUERY).matches
}

export function useCompactMailbox() {
  return useSyncExternalStore(subscribe, getSnapshot)
}
