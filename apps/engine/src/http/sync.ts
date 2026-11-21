import type {
  SyncChange,
  SyncChanges,
  SyncEntity,
  SyncSnapshotPage,
  SyncState,
} from '@amc/protocol'
import { SYNC_ENTITIES } from '@amc/protocol'
import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import type { Db } from '../db/database.ts'
import type { Drafts } from '../mail/drafts.ts'
import type { MailQueries } from '../mail/queries.ts'
import type { MailStore } from '../mail/store.ts'
import { type AppEnv, requireScope } from './app.ts'

export interface SyncDeps {
  db: Db
  store: MailStore
  queries: MailQueries
  drafts: Drafts
}

function load(deps: SyncDeps, entity: SyncEntity, id: string) {
  switch (entity) {
    case 'account':
      return deps.queries.account(id)
    case 'label':
      return deps.queries.label(id)
    case 'thread':
      return deps.queries.threadSummary(id)
    case 'message':
      return deps.queries.message(id)
    case 'draft':
      return deps.drafts.get(id)
  }
}

export function syncState(db: Db): SyncState {
  const row = db.prepare('SELECT max(modseq) AS hi, min(modseq) AS lo FROM change_log').get() as {
    hi: number | null
    lo: number | null
  }
  return { modseq: row.hi ?? 0, oldestModseq: row.lo ?? 0 }
}

/**
 * The replica sync protocol (plan §5): snapshot at a modseq, then changes since it, with a
 * Server-Sent Events stream that nudges Clients when something changed.
 */
export function syncRoutes(deps: SyncDeps) {
  const { db } = deps
  const r = new Hono<AppEnv>()

  r.get('/sync/state', requireScope('read'), (c) => c.json(syncState(db)))

  r.get('/sync/snapshot', requireScope('read'), (c) => {
    const entity = c.req.query('entity') as SyncEntity
    if (!SYNC_ENTITIES.includes(entity))
      return c.json({ error: 'bad_request', message: 'Unknown entity' }, 400)
    const cursor = c.req.query('cursor') || null
    const limit = Math.min(Number(c.req.query('limit')) || 500, 1000)
    let page: SyncSnapshotPage
    switch (entity) {
      case 'thread': {
        const p = deps.queries.threadPage(cursor, limit)
        page = { entity, rows: p.rows, cursor: p.next }
        break
      }
      case 'message': {
        const p = deps.queries.messagePage(cursor, limit)
        page = { entity, rows: p.rows, cursor: p.next }
        break
      }
      case 'account':
        page = { entity, rows: deps.queries.accounts(), cursor: null }
        break
      case 'label':
        page = { entity, rows: deps.queries.labels(), cursor: null }
        break
      case 'draft':
        page = { entity, rows: deps.drafts.list({ limit: 200 }), cursor: null }
        break
    }
    return c.json(page)
  })

  r.get('/sync/changes', requireScope('read'), (c) => {
    const since = Number(c.req.query('since') ?? 0)
    const limit = Math.min(Number(c.req.query('limit')) || 1000, 5000)
    const state = syncState(db)
    if (since > 0 && since < state.oldestModseq - 1) {
      return c.json({ error: 'resync_required', message: 'Too far behind; bootstrap again' }, 410)
    }
    const rows = db
      .prepare(
        'SELECT modseq, entity, entity_id, op FROM change_log WHERE modseq > ? ORDER BY modseq LIMIT ?',
      )
      .all(since, limit + 1) as {
      modseq: number
      entity: SyncEntity
      entity_id: string
      op: 'upsert' | 'delete'
    }[]
    const more = rows.length > limit
    const window = rows.slice(0, limit)
    // Collapse to the latest change per entity; send its current state.
    const latest = new Map<string, (typeof window)[number]>()
    for (const row of window) latest.set(`${row.entity}:${row.entity_id}`, row)
    const changes: SyncChange[] = []
    for (const row of latest.values()) {
      const data = row.op === 'upsert' ? load(deps, row.entity, row.entity_id) : null
      changes.push(
        data
          ? ({
              modseq: row.modseq,
              entity: row.entity,
              id: row.entity_id,
              op: 'upsert',
              data,
            } as SyncChange)
          : { modseq: row.modseq, entity: row.entity, id: row.entity_id, op: 'delete' },
      )
    }
    changes.sort((a, b) => a.modseq - b.modseq)
    const body: SyncChanges = { changes, modseq: window.at(-1)?.modseq ?? since, more }
    return c.json(body)
  })

  r.get('/sync/events', requireScope('read'), (c) =>
    streamSSE(c, async (stream) => {
      let pending = false
      const notify = () => {
        if (pending) return
        pending = true
        setTimeout(() => {
          pending = false
          void stream.writeSSE({
            event: 'change',
            data: JSON.stringify({ modseq: syncState(db).modseq }),
          })
        }, 150)
      }
      deps.store.on('change', notify)
      stream.onAbort(() => {
        deps.store.off('change', notify)
      })
      await stream.writeSSE({ event: 'hello', data: JSON.stringify(syncState(db)) })
      while (!stream.aborted) {
        await stream.sleep(25_000)
        await stream.writeSSE({ event: 'ping', data: '' })
      }
    }),
  )

  return r
}
