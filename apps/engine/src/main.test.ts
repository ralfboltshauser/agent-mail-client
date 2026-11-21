import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { writeFileSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { createServer } from 'node:net'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { Health } from '@amc/protocol'
import { expect, it } from 'vitest'
import { issueToken } from './auth/tokens.ts'
import { databasePath } from './config.ts'
import { migrate, openDatabase } from './db/database.ts'
import { testConfig } from './test-support.ts'

it('exits zero on SIGTERM with a replica event stream still open', async () => {
  const probe = createServer().listen({ port: 0, host: '127.0.0.1' })
  await once(probe, 'listening')
  const { port } = probe.address() as AddressInfo
  await new Promise<void>((resolve) => probe.close(() => resolve()))
  const config = testConfig({ listen: { port, host: '127.0.0.1' }, logLevel: 'info' })
  const configPath = join(config.dataDir, 'config.json')
  writeFileSync(configPath, JSON.stringify(config))
  writeFileSync(join(config.secretsDir, 'key'), Buffer.alloc(32))
  const db = openDatabase(databasePath(config))
  migrate(db)
  const { secret } = issueToken(db, { kind: 'desktop', name: 'test', scopes: ['read'] })
  db.close()

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
    const health = await fetch(`${url}/v1/health`, { headers })
    expect(health.status).toBe(200)
    expect(Health.parse(await health.json()).gmailPubSub).toEqual({
      enabled: false,
      pullHealthy: false,
      lastNotificationAt: null,
      pullErrorCount: 0,
      lastPullError: null,
    })
    const response = await fetch(`${url}/v1/sync/events`, { headers })
    expect(response.status).toBe(200)
    const reader = response.body?.getReader()
    expect(new TextDecoder().decode((await reader?.read())?.value)).toContain('event: hello')
    child.kill('SIGTERM')
    expect(await exited, output).toEqual([0, null])
    expect((await reader?.read())?.done).toBe(true)
  } finally {
    lines.close()
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    await exited
  }
}, 15_000)
