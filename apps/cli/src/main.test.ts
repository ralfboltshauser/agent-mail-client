import { execFile } from 'node:child_process'
import { once } from 'node:events'
import { createServer } from 'node:http'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'

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
