import type { Db } from './db/database.ts'

export interface Settings {
  /** ADR 0001: without this, no Agent has any means of sending mail. Changed only from the desktop app. */
  dangerouslyAllowSend: boolean
  undoSendSeconds: number
}

const DEFAULTS: Settings = { dangerouslyAllowSend: false, undoSendSeconds: 10 }

export function getSetting<K extends keyof Settings>(db: Db, key: K): Settings[K] {
  const row = db.prepare('SELECT value FROM setting WHERE key = ?').get(key) as
    | { value: string }
    | undefined
  return row ? (JSON.parse(row.value) as Settings[K]) : DEFAULTS[key]
}

export function setSetting<K extends keyof Settings>(db: Db, key: K, value: Settings[K]): void {
  db.prepare(
    'INSERT INTO setting (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value',
  ).run(key, JSON.stringify(value))
}
