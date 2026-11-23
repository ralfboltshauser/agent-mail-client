import { DatabaseSync } from 'node:sqlite'
import { parentPort, workerData } from 'node:worker_threads'
import { purgeErasure } from './physical-purge.ts'

const { path, epoch } = workerData as { path: string; epoch: string }
const db = new DatabaseSync(path, { enableForeignKeyConstraints: true })
try {
  db.exec('PRAGMA busy_timeout = 0; PRAGMA synchronous = FULL')
  parentPort?.postMessage(purgeErasure(db, epoch) ? 'purged' : 'deferred')
} catch (error) {
  const code = (error as { errcode?: number }).errcode ?? 0
  // SQLITE_BUSY and SQLITE_LOCKED include extended codes in the high bits.
  if (![5, 6].includes(code & 0xff)) throw error
  parentPort?.postMessage('deferred')
} finally {
  db.close()
}
