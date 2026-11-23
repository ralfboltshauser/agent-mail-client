import { execFile } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'

it.each(['0', '1'])('reports a missing triage account with AMC_DEBUG=%s', async (debug) => {
  const server = createServer((req, res) => {
    if (req.url !== '/v1/accounts') {
      res.writeHead(404).end('{}')
      return
    }
    res.setHeader('Content-Type', 'application/json')
    res.end(JSON.stringify({ accounts: [{ id: 'first' }, { id: 'second' }] }))
  })
  server.listen(0, '127.0.0.1')
  try {
    await once(server, 'listening')
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Expected a TCP address')
    const result = promisify(execFile)(
      process.execPath,
      [fileURLToPath(new URL('./main.ts', import.meta.url)), 'triage', '--dry-run'],
      {
        env: {
          ...process.env,
          AMC_ENGINE_URL: `http://127.0.0.1:${address.port}`,
          AMC_TOKEN: 'test',
          AMC_DEBUG: debug,
        },
      },
    )
    const message = 'Error: Choose an Account with --account <id> (see amc accounts --json)'
    const stderr = debug === '1' ? expect.stringMatching(/\n\s+at /) : `${message}\n`
    await expect(result).rejects.toMatchObject({ code: 1, stdout: '', stderr })
    await expect(result).rejects.toHaveProperty('stderr', expect.stringContaining(message))
  } finally {
    server.close()
  }
})

it('keeps Engine error details out of triage debug output', async () => {
  const privateDetail = 'synthetic-private-detail'
  const server = createServer((req, res) => {
    if (req.method === 'DELETE') {
      res.writeHead(204).end()
      return
    }
    res.writeHead(500, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: 'fixture', message: privateDetail }))
  })
  server.listen(0, '127.0.0.1')
  try {
    const run = await cliFor(server, { AMC_DEBUG: '1' })
    const result = run('triage', '--account', 'a', '--dry-run')
    await expect(result).rejects.toMatchObject({
      code: 1,
      stdout: '',
      stderr: expect.stringContaining('The Engine could not prepare triage.'),
    })
    await expect(result).rejects.toHaveProperty(
      'stderr',
      expect.not.stringContaining(privateDetail),
    )
  } finally {
    server.close()
  }
})

it.each([
  ['triage', '--account', 'gmail', 'filtered'],
  ['triage', 'filtered', '--account', 'gmail'],
])('sends the account scope for %j %j %j %j', async (...args) => {
  const requests: string[] = []
  const server = createServer((req, res) => {
    requests.push(req.url ?? '')
    res.setHeader('Content-Type', 'application/json')
    res.end(JSON.stringify({ threads: [], cursor: null }))
  })
  server.listen(0, '127.0.0.1')
  try {
    await once(server, 'listening')
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Expected a TCP address')
    await promisify(execFile)(
      process.execPath,
      [fileURLToPath(new URL('./main.ts', import.meta.url)), ...args],
      {
        env: {
          ...process.env,
          AMC_ENGINE_URL: `http://127.0.0.1:${address.port}`,
          AMC_TOKEN: 'test',
        },
      },
    )
    expect(requests).toEqual(['/v1/filtered?accountId=gmail'])
  } finally {
    server.close()
  }
})

it('reports unavailable backup health from an older Engine in doctor', async () => {
  const server = createServer((_req, res) => {
    res.setHeader('Content-Type', 'application/json')
    res.end(JSON.stringify({ disks: [] }))
  })
  server.listen(0, '127.0.0.1')
  try {
    await once(server, 'listening')
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Expected a TCP address')
    const { stdout, stderr } = await promisify(execFile)(
      process.execPath,
      [fileURLToPath(new URL('./main.ts', import.meta.url)), 'doctor'],
      {
        env: {
          ...process.env,
          AMC_ENGINE_URL: `http://127.0.0.1:${address.port}`,
          AMC_TOKEN: 'test',
        },
      },
    )
    expect(stderr).toContain('Backup status is unavailable from this Engine.')
    expect(stdout).not.toContain('No health warnings.')
  } finally {
    server.close()
  }
})

it('fetches deferred bodies before printing a thread', async () => {
  const requests: string[] = []
  const server = createServer((req, res) => {
    requests.push(req.url ?? '')
    res.setHeader('Content-Type', 'application/json')
    if (req.url === '/v1/threads/a%3At?deferBodies=1') {
      const header = { from: null, to: [], sentAt: 0, attachments: [] }
      res.end(
        JSON.stringify({
          subject: 'Test thread',
          messages: [
            { ...header, id: 'a:old', bodyText: null },
            { ...header, id: 'a:new', bodyText: 'Newest reply' },
          ],
        }),
      )
    } else if (req.url === '/v1/messages/a%3Aold') {
      res.end(JSON.stringify({ bodyText: 'Older reply' }))
    } else {
      res.writeHead(404).end('{}')
    }
  })
  server.listen(0, '127.0.0.1')
  try {
    await once(server, 'listening')
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Expected a TCP address')
    const { stdout } = await promisify(execFile)(
      process.execPath,
      [fileURLToPath(new URL('./main.ts', import.meta.url)), 'thread', 'a:t'],
      {
        env: {
          ...process.env,
          AMC_ENGINE_URL: `http://127.0.0.1:${address.port}`,
          AMC_TOKEN: 'test',
        },
      },
    )
    expect(requests).toEqual(['/v1/threads/a%3At?deferBodies=1', '/v1/messages/a%3Aold'])
    expect(stdout).toMatch(/Older reply[\s\S]*Newest reply/)
    expect(stdout).not.toContain('null')
  } finally {
    server.close()
  }
})

it('submits a no-reply Snooze when the Engine advertises Snooze', async () => {
  const requests: unknown[] = []
  const server = createServer(async (req, res) => {
    res.setHeader('Content-Type', 'application/json')
    if (req.url === '/v1/me') {
      res.end(JSON.stringify({ features: { snooze: true } }))
    } else if (req.url === '/v1/mutations') {
      const chunks: Buffer[] = []
      for await (const chunk of req) chunks.push(chunk as Buffer)
      const { mutations } = JSON.parse(Buffer.concat(chunks).toString())
      requests.push(...mutations)
      res.end(
        JSON.stringify({
          mutations: [
            { id: mutations[0].id, threadId: 'a:t', status: 'applied', error: null, modseq: 1 },
          ],
        }),
      )
    } else {
      res.writeHead(404).end('{}')
    }
  })
  server.listen(0, '127.0.0.1')
  try {
    await once(server, 'listening')
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Expected a TCP address')
    const until = new Date(Date.now() + 60_000)
    await promisify(execFile)(
      process.execPath,
      [
        fileURLToPath(new URL('./main.ts', import.meta.url)),
        'snooze',
        'a:t',
        until.toISOString(),
        '--if-no-reply',
      ],
      {
        env: {
          ...process.env,
          AMC_ENGINE_URL: `http://127.0.0.1:${address.port}`,
          AMC_TOKEN: 'test',
        },
      },
    )
    expect(requests).toMatchObject([
      { action: { kind: 'snooze', threadId: 'a:t', until: until.getTime(), noReply: true } },
    ])
  } finally {
    server.close()
  }
})

it('dispatches legacy triage flags and the queue subcommand independently', async () => {
  const requests: string[] = []
  const card = {
    id: { kind: 'sender', accountId: 'a', address: 'person@example.test' },
    accountId: 'a',
    threadId: 'a:t',
    messageId: 'a:m',
    threadRevision: 8,
    revision: 2,
    reason: 'New sender',
  }
  const server = createServer((req, res) => {
    requests.push(req.url ?? '')
    if (req.url === '/v1/triage/lease') res.end(JSON.stringify({ granted: false }))
    else if (req.url === '/v1/triage/queue?accountId=a&limit=7') {
      res.end(JSON.stringify({ revision: 9, cards: [card], cursor: null }))
    } else res.writeHead(404).end('{}')
  })
  server.listen(0, '127.0.0.1')
  try {
    const run = await cliFor(server)
    expect((await run('triage', '--account', 'a', '--recent', '--dry-run')).stdout).toContain(
      'Triage is already running',
    )
    expect(
      JSON.parse((await run('triage', 'queue', '--account', 'a', '--limit', '7', '--json')).stdout),
    ).toEqual({ revision: 9, cards: [card], cursor: null })
    expect(requests).toEqual(['/v1/triage/lease', '/v1/triage/queue?accountId=a&limit=7'])
  } finally {
    server.close()
  }
})

it('uses the exact Sender revision and exits nonzero for a partial action or Undo', async () => {
  const requests: unknown[] = []
  const actionId = 'f1ba9543-97da-4d79-9ebd-f2889ac286f0'
  const action = {
    actionId,
    accountId: 'a',
    kind: 'sender:decision',
    status: 'partial',
    revision: 5,
    error: 'One message changed on the provider',
    mutationIds: ['mutation-1'],
    undo: null,
  }
  const sender = {
    accountId: 'a',
    address: 'alice@example.test',
    status: 'new',
    revision: 4,
    suggestions: [],
  }
  const server = createServer(async (req, res) => {
    requests.push(req.url)
    if (req.url?.startsWith('/v1/senders?')) {
      res.end(JSON.stringify({ rows: [sender], cursor: null }))
    } else if (req.url === '/v1/senders/decisions') {
      const chunks: Buffer[] = []
      for await (const chunk of req) chunks.push(chunk as Buffer)
      requests.push(JSON.parse(Buffer.concat(chunks).toString()))
      res.end(JSON.stringify(action))
    } else if (req.url === `/v1/owner-actions/${actionId}/undo`) {
      res.end(
        JSON.stringify({
          ...action,
          status: 'applied',
          undo: { status: 'partial', error: 'Undo conflict', mutationIds: ['undo-1'] },
        }),
      )
    } else res.writeHead(404).end('{}')
  })
  server.listen(0, '127.0.0.1')
  try {
    const run = await cliFor(server)
    expect(
      JSON.parse(
        (await run('senders', 'list', '--account', 'a', '--status', 'new', '--json')).stdout,
      ).rows,
    ).toEqual([sender])
    await expect(
      run('senders', 'block', 'ALICE@example.test', '--account', 'a'),
    ).rejects.toMatchObject({ code: 1, stdout: expect.stringContaining('mutation-1') })
    expect(requests).toContainEqual({
      accountId: 'a',
      address: 'ALICE@example.test',
      decision: 'block',
      expectedRevision: 4,
      clientActionId: expect.stringMatching(/^[0-9a-f-]{36}$/),
    })
    await expect(run('senders', 'undo', actionId)).rejects.toMatchObject({
      code: 1,
      stdout: expect.stringContaining('undo-1'),
    })
  } finally {
    server.close()
  }
})

it('uses only Engine avatar metadata and writes a ready fixture PNG on request', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'amc-avatar-'))
  const output = join(dir, 'sender.png')
  const digest = 'b'.repeat(64)
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACklEQVR4nGNgAAAAAgABSK+kcQAAAABJRU5ErkJggg==',
    'base64',
  )
  const requests: unknown[] = []
  const server = createServer(async (req, res) => {
    requests.push(req.url)
    if (req.url === '/v1/sender-avatars/resolve') {
      const chunks: Buffer[] = []
      for await (const chunk of req) chunks.push(chunk as Buffer)
      const { messages } = JSON.parse(Buffer.concat(chunks).toString())
      requests.push(messages)
      res.end(
        JSON.stringify({
          rows: messages.map((message: { messageId: string }) => ({
            ...message,
            initials: 'PS',
            color: '#694abc',
            ...(message.messageId === 'a:fallback'
              ? { source: 'initials', digest: null }
              : { source: 'favicon', digest }),
          })),
        }),
      )
    } else if (req.url === `/v1/sender-avatars/${digest}`) {
      res.setHeader('Content-Type', 'image/png').end(png)
    } else res.writeHead(404).end('{}')
  })
  server.listen(0, '127.0.0.1')
  try {
    const run = await cliFor(server)
    expect(JSON.parse((await run('senders', 'avatar', 'a:fallback')).stdout)).toMatchObject({
      accountId: 'a',
      messageId: 'a:fallback',
      source: 'initials',
      digest: null,
    })
    const ready = JSON.parse(
      (await run('senders', 'avatar', 'a:ready:uid', '--out', output)).stdout,
    )
    expect(ready).toEqual({
      accountId: 'a',
      messageId: 'a:ready:uid',
      initials: 'PS',
      color: '#694abc',
      source: 'favicon',
      digest,
    })
    expect(await readFile(output)).toEqual(png)
    expect(requests).toEqual([
      '/v1/sender-avatars/resolve',
      [{ accountId: 'a', messageId: 'a:fallback' }],
      '/v1/sender-avatars/resolve',
      [{ accountId: 'a', messageId: 'a:ready:uid' }],
      `/v1/sender-avatars/${digest}`,
    ])
  } finally {
    server.close()
    await rm(dir, { recursive: true, force: true })
  }
})

async function cliFor(server: ReturnType<typeof createServer>, env: NodeJS.ProcessEnv = {}) {
  await once(server, 'listening')
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Expected a TCP address')
  return (...args: string[]) =>
    promisify(execFile)(
      process.execPath,
      [fileURLToPath(new URL('./main.ts', import.meta.url)), ...args],
      {
        env: {
          ...process.env,
          AMC_ENGINE_URL: `http://127.0.0.1:${address.port}`,
          AMC_TOKEN: 'fixture',
          ...env,
        },
      },
    )
}
