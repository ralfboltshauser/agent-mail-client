import { type CSSProperties, useCallback, useSyncExternalStore } from 'react'
import { recordCaughtFailure } from '@/lib/failure'

export const avatarShapes = {
  circle: { label: 'Circle', style: { borderRadius: '50%' } },
  square: { label: 'Square', style: { borderRadius: '25%' } },
  blob: {
    label: 'Blob',
    style: { borderRadius: '70% 40% 62% 36% / 38% 66% 40% 68%' },
  },
  diamond: {
    label: 'Diamond',
    style: { clipPath: 'polygon(50% 0, 100% 50%, 50% 100%, 0 50%)' },
  },
  hexagon: {
    label: 'Hexagon',
    style: { clipPath: 'polygon(25% 0, 75% 0, 100% 50%, 75% 100%, 25% 100%, 0 50%)' },
  },
} satisfies Record<string, { label: string; style: CSSProperties }>

export type AvatarShape = keyof typeof avatarShapes

const defaultShape: AvatarShape = 'circle'
const storageKey = (accountId: string) => `amc.account-avatar-shape.v1:${accountId}`
const savedShapes = new Map<string, AvatarShape>()
const changes = new EventTarget()
const noop = () => {}

function readShape(accountId: string | undefined): AvatarShape {
  if (!accountId) return defaultShape
  const cached = savedShapes.get(accountId)
  if (cached) return cached

  let shape: AvatarShape = defaultShape
  try {
    const saved = localStorage.getItem(storageKey(accountId))
    if (saved && Object.hasOwn(avatarShapes, saved)) shape = saved as AvatarShape
  } catch (error) {
    recordCaughtFailure(error)
  }
  savedShapes.set(accountId, shape)
  return shape
}

export function useAccountAvatarShape(accountId: string | undefined) {
  const subscribe = useCallback(
    (listener: () => void) => {
      if (!accountId) return noop
      changes.addEventListener(accountId, listener)
      return () => changes.removeEventListener(accountId, listener)
    },
    [accountId],
  )
  return useSyncExternalStore(subscribe, () => readShape(accountId))
}

export function setAccountAvatarShape(accountId: string, shape: AvatarShape) {
  if (readShape(accountId) === shape) return
  if (shape === defaultShape) localStorage.removeItem(storageKey(accountId))
  else localStorage.setItem(storageKey(accountId), shape)
  savedShapes.set(accountId, shape)
  changes.dispatchEvent(new Event(accountId))
}
