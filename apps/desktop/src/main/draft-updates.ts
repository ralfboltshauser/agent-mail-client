import type { DatabaseSync } from 'node:sqlite'
import type { ComposePatch } from '@amc/protocol'
import type { EngineClient } from './engine'

export function composeDraftPath(id: string): string {
  return `/v1/compose/drafts/${encodeURIComponent(id)}`
}

export class LocalDraftUpdates {
  #flush: Promise<void> | null = null

  readonly #db: DatabaseSync

  constructor(db: DatabaseSync) {
    this.#db = db
    db.exec(`CREATE TABLE IF NOT EXISTS draft_update (
      id TEXT PRIMARY KEY, revision INTEGER NOT NULL, body TEXT NOT NULL
    ) STRICT`)
  }

  stage(id: string, patch: ComposePatch): void {
    this.#db
      .prepare('INSERT OR REPLACE INTO draft_update VALUES (?, ?, ?)')
      .run(id, patch.baseRevision, patch.update)
  }

  acknowledge(id: string, update: string): void {
    this.#db.prepare('DELETE FROM draft_update WHERE id = ? AND body = ?').run(id, update)
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
    const updates = this.#db.prepare('SELECT * FROM draft_update').all() as {
      id: string
      revision: number
      body: string
    }[]
    const signal = AbortSignal.timeout(3_000)
    await Promise.all(
      updates.map(async ({ id, revision, body }) => {
        try {
          await engine.request(composeDraftPath(id), {
            method: 'PUT',
            body: { baseRevision: revision, update: body },
            signal,
          })
          this.acknowledge(id, body)
        } catch {
          // Keep unacknowledged updates in the replica for the next flush.
        }
      }),
    )
  }
}
