import { Diagnostics } from '@amc/protocol'
import { Hono } from 'hono'
import { type Db, schemaVersion } from '../db/database.ts'
import { type EngineDiagnostics, OperationStatus } from '../db/diagnostics.ts'
import { pendingPurgeEpoch } from '../mail/triage/physical-purge.ts'
import { VERSION } from '../version.ts'
import { type AppEnv, requireOwnerAdmin } from './app.ts'

export function diagnosticsRoutes(db: Db, state: EngineDiagnostics) {
  return new Hono<AppEnv>().get('/diagnostics', requireOwnerAdmin, (c) => {
    const accounts = db.prepare('SELECT id, kind FROM account ORDER BY id').all() as {
      id: string
      kind: 'gmail' | 'imap'
    }[]
    const project = (statuses: ReadonlyMap<string, OperationStatus>, kind?: 'imap') =>
      accounts.flatMap(({ id, kind: provider }) =>
        /^acc_[A-Za-z0-9_-]{12}$/.test(id) && (!kind || kind === provider)
          ? [{ accountId: id, status: (statuses.get(id) ?? new OperationStatus()).snapshot() }]
          : [],
      )
    return c.json(
      Diagnostics.parse({
        version: VERSION,
        schemaVersion: schemaVersion(db),
        uptimeSeconds: Math.max(0, Math.floor((Date.now() - state.startedAt) / 1000)),
        queues: {
          mutations: Number(
            db.prepare("SELECT count(*) AS n FROM mutation WHERE status = 'pending'").get()?.n,
          ),
          outbox: Number(
            db
              .prepare("SELECT count(*) AS n FROM outbox WHERE status IN ('queued', 'dispatching')")
              .get()?.n,
          ),
          purge: Number(Boolean(pendingPurgeEpoch(db))),
        },
        syncAccounts: project(state.sync),
        imapIdle: project(state.idle, 'imap'),
        pubSub: state.pubSub.snapshot(),
        purge: state.purge.snapshot(),
        outbox: state.outbox.snapshot(),
        migrations: state.migrations.snapshot(),
      }),
    )
  })
}
