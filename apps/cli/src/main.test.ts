import { execFile } from 'node:child_process'
import { once } from 'node:events'
import { createServer } from 'node:http'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'

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
