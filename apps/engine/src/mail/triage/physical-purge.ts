import type { Db } from '../../db/database.ts'

export function pendingPurgeEpoch(db: Db): string | undefined {
  const epoch = db
    .prepare('SELECT receipt_epoch FROM triage_privacy_store WHERE purge_pending = 1')
    .get()?.receipt_epoch
  return typeof epoch === 'string' ? epoch : undefined
}

export function purgeErasure(db: Db, epoch: string): boolean {
  const checkpoint = () => db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get()?.busy === 0
  // A reader can pin old WAL frames. Check before the full rewrite and again
  // afterwards, since readers can arrive during VACUUM.
  if (!checkpoint()) return false
  db.exec('PRAGMA secure_delete = ON; VACUUM')
  if (!checkpoint()) return false
  // A Forget that commits during maintenance must have a purge of its own.
  return (
    db
      .prepare('UPDATE triage_privacy_store SET purge_pending = 0 WHERE receipt_epoch = ?')
      .run(epoch).changes === 1
  )
}
