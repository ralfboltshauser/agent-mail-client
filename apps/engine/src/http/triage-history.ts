import { TriageExportInput, TriageHistoryQuery } from '@amc/protocol'
import { Hono } from 'hono'
import type { Db } from '../db/database.ts'
import { assertOwner } from '../mail/senders/actions.ts'
import { forgetDecision } from '../mail/triage/erasure.ts'
import { exportHistory, readHistory } from '../mail/triage/history.ts'
import type { AppEnv } from './app.ts'
import { readJson } from './json.ts'

export function triageHistoryRoutes(db: Db) {
  const routes = new Hono<AppEnv>()
  routes.use('*', async (c, next) => {
    assertOwner(db, c.get('principal'))
    c.header('Cache-Control', 'no-store')
    await next()
  })
  routes.get('/', (c) => {
    const query = TriageHistoryQuery.safeParse(c.req.query())
    if (!query.success)
      return c.json({ error: 'bad_request', message: 'Invalid history query' }, 400)
    return c.json(readHistory(db, query.data))
  })
  routes.post('/export', async (c) => {
    const input = TriageExportInput.safeParse(await readJson(c.req))
    if (!input.success)
      return c.json({ error: 'bad_request', message: 'Invalid export scope' }, 400)
    return c.body(exportHistory(db, input.data), 200, {
      'Content-Type': 'application/x-ndjson; charset=utf-8',
      'Content-Disposition': 'attachment; filename="amc-owner-preferences.jsonl"',
    })
  })
  routes.delete('/:id', (c) => {
    return c.json(forgetDecision(db, c.req.param('id')))
  })
  return routes
}
