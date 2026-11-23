import type { DatabaseSync } from 'node:sqlite'
import { newRunId } from '@amc/observability'
import type { ComposePatch } from '@amc/protocol'
import type { EngineClient } from './engine'
import { failureScope, knownFailure, mainLog } from './observability'

export function composeDraftPath(id: string): string {
  return `/v1/compose/drafts/${encodeURIComponent(id)}`
}

export class LocalDraftUpdates {
  #flush: Promise<void> | null = null
  #failed = false

  readonly #db: DatabaseSync

  constructor(db: DatabaseSync) {
    this.#db = db
    db.exec(`CREATE TABLE IF NOT EXISTS draft_update (
      id TEXT PRIMARY KEY, revision INTEGER NOT NULL, body TEXT NOT NULL, fields TEXT
    ) STRICT`)
    const columns = db.prepare('PRAGMA table_info(draft_update)').all()
    if (!columns.some((column) => column.name === 'fields')) {
      db.exec('ALTER TABLE draft_update ADD COLUMN fields TEXT')
    }
  }

  stage(id: string, patch: ComposePatch): void {
    this.#db
      .prepare(
        'INSERT OR REPLACE INTO draft_update (id, revision, body, fields) VALUES (?, ?, ?, ?)',
      )
      .run(id, patch.baseRevision, patch.update, JSON.stringify(patch.fields) ?? null)
  }

  acknowledge(id: string, patch: ComposePatch): void {
    this.#db
      .prepare(
        'DELETE FROM draft_update WHERE id = ? AND revision = ? AND body = ? AND fields IS ?',
      )
      .run(id, patch.baseRevision, patch.update, JSON.stringify(patch.fields) ?? null)
  }

  discard(id: string): void {
    this.#db.prepare('DELETE FROM draft_update WHERE id = ?').run(id)
  }

  clear(): void {
    this.#db.exec('DELETE FROM draft_update')
  }

  flush(engine: Pick<EngineClient, 'request'> | null): Promise<void> {
    if (!engine) return Promise.resolve()
    if (this.#flush) return this.#flush.then(() => this.flush(engine))
    this.#flush = this.#send(engine).finally(() => {
      this.#flush = null
    })
    return this.#flush
  }

  async #send(engine: Pick<EngineClient, 'request'>): Promise<void> {
    const runId = newRunId()
    const stage = 'draft-replay'
    const log = mainLog.with({ runId })
    try {
      const updates = this.#db.prepare('SELECT * FROM draft_update').all() as {
        id: string
        revision: number
        body: string
        fields: string | null
      }[]
      if (!updates.length) return
      log.log('debug', 'desktop.operation.started', { stage })
      const signal = AbortSignal.timeout(3_000)
      const results = await Promise.allSettled(
        updates.map(async ({ id, revision, body, fields }) => {
          const patch: ComposePatch = { baseRevision: revision, update: body }
          if (fields !== null) patch.fields = JSON.parse(fields)
          await engine.request(composeDraftPath(id), { method: 'PUT', body: patch, signal })
          this.acknowledge(id, patch)
        }),
      )
      // Keep unacknowledged updates in the replica for the next flush.
      const failed = results.find((result) => result.status === 'rejected')
      if (failed) throw failed.reason
      log.log(this.#failed ? 'info' : 'debug', 'desktop.operation.finished', { stage })
      this.#failed = false
    } catch (err) {
      const details = knownFailure(err)
      log.log('error', 'desktop.operation.failed', { stage, err }, details && failureScope(details))
      this.#failed = true
    }
  }
}
