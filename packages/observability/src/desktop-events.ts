import { errorClasses } from './errors.ts'

const syncPhases = [
  'unpaired',
  'restoring-pairing',
  'pairing-read-error',
  'connecting',
  'bootstrapping',
  'live',
  'paused',
  'offline',
  'error',
] as const
const pairingStages = ['reading', 'loaded', 'unreadable', 'rejected'] as const
export const desktopEvents = {
  'desktop.startup.pairing': { fields: { stage: pairingStages } },
  'desktop.sync.phase': {
    fields: { phase: syncPhases },
    message: (fields: Readonly<Record<string, unknown>>) => `Engine sync phase: ${fields.phase}`,
  },
  'renderer.failure': {
    fields: {
      errorClass: errorClasses,
      source: ['window.error', 'window.unhandledrejection', 'react.boundary', 'ipc.rejected'],
    },
  },
} as const
