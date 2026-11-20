import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'

/**
 * Catches an OAuth redirect on a loopback port of this machine. Google allows any loopback
 * port for Desktop clients, so the browser never needs to reach the Engine directly.
 */
export async function loopbackSignIn(
  start: (redirectUri: string) => Promise<{ authUrl: string; state: string }>,
  timeoutMs = 5 * 60_000,
): Promise<{ code: string; state: string }> {
  const server = createServer()
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  const redirectUri = `http://127.0.0.1:${port}/callback`

  try {
    const { authUrl, state } = await start(redirectUri)
    const result = new Promise<{ code: string; state: string }>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('Timed out waiting for the Google sign-in')),
        timeoutMs,
      )
      server.on('request', (req, res) => {
        const url = new URL(req.url ?? '/', redirectUri)
        if (url.pathname !== '/callback') {
          res.writeHead(404).end()
          return
        }
        const error = url.searchParams.get('error')
        const code = url.searchParams.get('code')
        const returned = url.searchParams.get('state')
        const ok = !error && code && returned === state
        res.writeHead(ok ? 200 : 400, { 'Content-Type': 'text/html; charset=utf-8' })
        res.end(
          page(
            ok
              ? 'Signed in. You can close this tab and go back to the terminal.'
              : `Sign-in failed: ${error ?? 'state mismatch'}`,
          ),
        )
        clearTimeout(timer)
        if (ok) resolve({ code, state })
        else reject(new Error(`Google sign-in failed: ${error ?? 'state mismatch'}`))
      })
    })
    console.log('Opening your browser to sign in with Google…')
    console.log(`If it does not open, visit:\n${authUrl}\n`)
    openBrowser(authUrl)
    return await result
  } finally {
    server.close()
  }
}

function openBrowser(url: string) {
  const command =
    process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer' : 'xdg-open'
  spawn(command, [url], { stdio: 'ignore', detached: true })
    .on('error', () => {})
    .unref()
}

function page(message: string) {
  const safe = message.replace(
    /[&<>]/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c] ?? c,
  )
  return `<!doctype html><meta charset="utf-8"><title>AMC</title><body style="font:16px system-ui;padding:48px;color:#222">${safe}</body>`
}
