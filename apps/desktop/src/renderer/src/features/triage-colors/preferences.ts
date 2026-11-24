import { BUCKETS, type Bucket, bucketLabels } from '@amc/protocol'
import { recordCaughtFailure } from '@/lib/failure'

export const triageColors = [
  'Neutral',
  'Slate',
  'Blue',
  'Violet',
  'Amber',
  'Teal',
  'Green',
  'Rose',
] as const
export type TriageColor = (typeof triageColors)[number]
export type TriageColorChoice = TriageColor | 'Default'

export const defaultTriageColors = {
  Reply: 'Blue',
  Action: 'Amber',
  'Follow-up': 'Violet',
  Update: 'Green',
  Later: 'Teal',
  'When I have time': 'Slate',
  Newsletters: 'Rose',
} satisfies Record<Bucket, TriageColor>

const storageKey = (bucket: Bucket) => `amc.triage-color.v1:${bucketLabels[bucket]}`
const bucketProperty = (bucket: Bucket) =>
  `--triage-color-${bucketLabels[bucket].slice('bucket.'.length)}`
const paletteColor = (color: TriageColor) => `var(--triage-palette-${color.toLowerCase()})`

export const bucketColor = (bucket: Bucket) =>
  `var(${bucketProperty(bucket)}, ${paletteColor(defaultTriageColors[bucket])})`

export function readTriageColor(bucket: Bucket): TriageColorChoice {
  try {
    const saved = localStorage.getItem(storageKey(bucket))
    return triageColors.find((color) => color === saved) ?? 'Default'
  } catch (error) {
    recordCaughtFailure(error)
    return 'Default'
  }
}

function applyTriageColor(bucket: Bucket, choice: TriageColorChoice) {
  const style = document.documentElement.style
  if (choice === 'Default') style.removeProperty(bucketProperty(bucket))
  else style.setProperty(bucketProperty(bucket), paletteColor(choice))
}

export function restoreTriageColors() {
  for (const bucket of BUCKETS) applyTriageColor(bucket, readTriageColor(bucket))
}

export function saveTriageColor(bucket: Bucket, choice: TriageColorChoice) {
  if (choice === 'Default') localStorage.removeItem(storageKey(bucket))
  else localStorage.setItem(storageKey(bucket), choice)
  applyTriageColor(bucket, choice)
}
