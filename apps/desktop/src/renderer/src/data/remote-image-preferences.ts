import { useSyncExternalStore } from 'react'
import { toast } from 'sonner'
import { failureText, recordCaughtFailure } from '@/lib/failure'

const storageKey = 'amc.remote-images.v1'

interface Preferences {
  automatic: boolean
  senders: string[]
}

const defaults: Preferences = { automatic: false, senders: [] }
const listeners = new Set<() => void>()
let cachedValue: string | null | undefined
let preferences = defaults

function readPreferences(): Preferences {
  try {
    const value = localStorage.getItem(storageKey)
    if (cachedValue !== value) {
      cachedValue = value
      preferences = defaults
      if (value !== null) {
        const saved = JSON.parse(value) as Partial<Preferences> | null
        preferences = {
          automatic: saved?.automatic === true,
          senders: Array.isArray(saved?.senders) ? saved.senders : [],
        }
      }
    }
  } catch (error) {
    recordCaughtFailure(error)
    return defaults
  }
  return preferences
}

function savePreferences(next: Preferences) {
  try {
    localStorage.setItem(storageKey, JSON.stringify(next))
  } catch (error) {
    toast.error('Could not save remote image preferences', { description: failureText(error) })
    return
  }
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function senderPreferenceKey(accountId: string, address: string | null) {
  const normalized = address?.trim().toLowerCase()
  return normalized ? JSON.stringify([accountId, normalized]) : null
}

export function useRemoteImages(senderKey: string | null = null) {
  return useSyncExternalStore(subscribe, () => {
    const { automatic, senders } = readPreferences()
    return automatic || (senderKey !== null && senders.includes(senderKey))
  })
}

export function setLoadRemoteImagesAutomatically(automatic: boolean) {
  const current = readPreferences()
  if (current.automatic !== automatic) savePreferences({ ...current, automatic })
}

export function allowRemoteImagesFromSender(senderKey: string) {
  const current = readPreferences()
  if (!current.senders.includes(senderKey)) {
    savePreferences({ ...current, senders: [...current.senders, senderKey] })
  }
}
