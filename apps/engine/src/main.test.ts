import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { createServer } from 'node:net'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { DatabaseSync } from 'node:sqlite'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { Health, type TriageHistoryPage } from '@amc/protocol'
import { expect, it } from 'vitest'
import { issueToken } from './auth/tokens.ts'
import { databasePath } from './config.ts'
import { type Db, migrate, openDatabase } from './db/database.ts'
import { annotate } from './mail/triage/annotations.ts'
import { ERASURE_LEDGER_FILE, forgetDecision, openErasureLedger } from './mail/triage/erasure.ts'
import { legacyDecisionId } from './mail/triage/legacy.ts'
import { testConfig } from './test-support.ts'

async function withEngine(
  seed: (db: Db, path: string, ledger: string) => string,
  run: (request: (path: string) => Promise<Response>, stop: () => Promise<void>) => Promise<void>,
) {
  const probe = createServer().listen({ port: 0, host: '127.0.0.1' })
  await once(probe, 'listening')
  const { port } = probe.address() as AddressInfo
  await new Promise<void>((resolve) => probe.close(() => resolve()))
  const config = testConfig({ listen: { port, host: '127.0.0.1' }, logLevel: 'info' })
  const configPath = join(config.dataDir, 'config.json')
  writeFileSync(configPath, JSON.stringify(config))
  writeFileSync(join(config.secretsDir, 'key'), Buffer.alloc(32))
  const path = databasePath(config)
  const db = openDatabase(path)
  let secret: string
  try {
    migrate(db)
    secret = seed(db, path, join(config.dataDir, ERASURE_LEDGER_FILE))
  } finally {
    db.close()
  }

  const child = spawn(process.execPath, [fileURLToPath(new URL('./main.ts', import.meta.url))], {
    env: { ...process.env, AMC_CONFIG: configPath },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const exited = once(child, 'close')
  let output = ''
  child.stdout.on('data', (chunk) => {
    output += chunk
  })
  child.stderr.on('data', (chunk) => {
    output += chunk
  })
  const lines = createInterface({ input: child.stdout })
  const ready = async () => {
    for await (const line of lines) {
      if (JSON.parse(line).msg === 'engine listening') return
    }
    await exited
    throw new Error(`Engine exited before listening:\n${output}`)
  }
  try {
    const url = `http://127.0.0.1:${port}`
    await ready()
    const headers = { Authorization: `Bearer ${secret}` }
    await run(
      (path) => fetch(`${url}${path}`, { headers, signal: AbortSignal.timeout(5000) }),
      async () => {
        child.kill('SIGTERM')
        expect(await exited, output).toEqual([0, null])
      },
    )
  } finally {
    lines.close()
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    await exited
    rmSync(config.dataDir, { recursive: true, force: true })
  }
}

it('exits zero on SIGTERM with a replica event stream still open', async () => {
  await withEngine(
    (db) => issueToken(db, { kind: 'desktop', name: 'test', scopes: ['read'] }).secret,
    async (request, stop) => {
      const health = await request('/v1/health')
      expect(health.status).toBe(200)
      expect(Health.parse(await health.json()).gmailPubSub).toEqual({
        enabled: false,
        pullHealthy: false,
        lastNotificationAt: null,
        pullErrorCount: 0,
        lastPullError: null,
      })
      const response = await request('/v1/sync/events')
      expect(response.status).toBe(200)
      const reader = response.body?.getReader()
      expect(new TextDecoder().decode((await reader?.read())?.value)).toContain('event: hello')
      await stop()
      expect((await reader?.read())?.done).toBe(true)
    },
  )
}, 15_000)

it('serves with an interrupted Forget and retries physical purge after a SQLite reader closes', async () => {
  const canary = 'synthetic-forget-while-a-reader-is-open'
  let reader: DatabaseSync | undefined
  let path: string
  try {
    await withEngine(
      (db, dbPath, ledgerPath) => {
        path = dbPath
        const closeLedger = openErasureLedger(db, ledgerPath)
        try {
          db.exec(`
            INSERT INTO account (id, kind, address, credentials, created_at, status)
            VALUES ('fixture', 'gmail', 'owner@example.test', X'00', 0, 'auth_expired')
          `)
          const action = {
            accountId: 'fixture',
            axis: 'filter',
            source: 'triage_key',
            label: 'filter.filtered',
            reason: canary,
          } as const
          const first = annotate(db, { ...action, actionId: 'forget-first' })
          const second = annotate(db, { ...action, actionId: 'forget-second' })
          const { secret } = issueToken(db, {
            kind: 'cli',
            name: 'test',
            scopes: ['admin', 'read'],
          })

          reader = new DatabaseSync(path, { readOnly: true })
          reader.exec('BEGIN')
          expect(reader.prepare('SELECT count(*) AS n FROM triage_owner_reason').get()?.n).toBe(2)

          expect(forgetDecision(db, first)).toEqual({ physicalPurge: 'pending' })
          db.exec('PRAGMA busy_timeout = 0')
          expect(db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get()?.busy).toBe(1)
          // Simulate a second interruption after the ledger commit and before the live commit.
          const ledger = new DatabaseSync(ledgerPath)
          try {
            ledger
              .prepare('INSERT INTO erasure VALUES (?, ?, ?, 1)')
              .run(second, 'forget-second', legacyDecisionId('fixture', 'forget-second'))
          } finally {
            ledger.close()
          }
          return secret
        } finally {
          closeLedger()
        }
      },
      async (request, stop) => {
        const history = async (): Promise<TriageHistoryPage> => {
          const response = await request('/v1/triage/events?includeReasons=1')
          expect(response.status).toBe(200)
          return response.json()
        }
        expect(await history()).toMatchObject({ events: [], physicalPurge: 'pending' })
        expect((await request('/v1/health')).status).toBe(200)

        // Keep the reader open across a maintenance tick and confirm it still pins the old view.
        await delay(2500)
        expect((await history()).physicalPurge).toBe('pending')
        expect(reader?.prepare('SELECT reason FROM triage_owner_reason').get()?.reason).toBe(canary)
        reader?.close()
        reader = undefined

        await expect
          .poll(async () => (await history()).physicalPurge, { timeout: 10_000 })
          .toBe('completed')
        expect(readFileSync(path).includes(canary)).toBe(false)
        expect(readFileSync(`${path}-wal`).includes(canary)).toBe(false)
        await stop()
      },
    )
  } finally {
    reader?.close()
  }
}, 20_000)
