import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import {
  type OAuthClientProvider,
  UnauthorizedError,
} from '@modelcontextprotocol/sdk/client/auth.js'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type {
  OAuthClientInformationMixed,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js'
import { app, shell } from 'electron'
import type { T3Project } from '../shared/api'
import { archiveLegacyCredentials, credentialPath, writeCredentials } from './credential-files'
import type { T3Launch, T3Launcher, T3Thread } from './handoff'

interface Credentials {
  url: string
  redirect: string
  info?: OAuthClientInformationMixed
  tokens?: OAuthTokens
}

const pairingFile = () => credentialPath(app.getPath('userData'), 't3-pairing.json')
function loadPairing(): Credentials | null {
  try {
    archiveLegacyCredentials(join(app.getPath('userData'), 't3-pairing.json'))
    return JSON.parse(readFileSync(pairingFile(), 'utf8')) as Credentials
  } catch {
    return null
  }
}

export function savedT3Url() {
  return loadPairing()?.url ?? ''
}

let connection: { url: string; client: Promise<Client> } | undefined

function t3Url(address: string): URL {
  const url = new URL(address)
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
  if (
    (url.protocol !== 'https:' && !(loopback && url.protocol === 'http:')) ||
    url.pathname !== '/mcp' ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error('Enter the MCP URL copied from T3 Code.')
  }
  return url
}

export function t3Client(address: string): Promise<Client> {
  const url = t3Url(address)
  if (connection?.url === url.href) return connection.client
  const previous = connection
  const client = connectT3(url).catch((error: unknown) => {
    if (connection?.client === client) connection = undefined
    throw error
  })
  connection = { url: url.href, client }
  void previous?.client.then((client) => client.close()).catch(() => {})
  return client
}

async function connectT3(url: URL): Promise<Client> {
  const saved = loadPairing()
  const stored = saved?.url === url.href ? saved : null
  const client = new Client({ name: 'AMC Desktop', version: '1.0.0' })
  if (stored?.tokens) {
    const provider = oauthProvider(stored)
    const transport = new StreamableHTTPClientTransport(url, { authProvider: provider })
    try {
      await client.connect(transport)
      return client
    } catch (error) {
      await transport.close()
      if (!(error instanceof UnauthorizedError)) throw error
    }
  }
  return pairT3(url)
}

function oauthProvider(
  state: Credentials,
  redirectToAuthorization: OAuthClientProvider['redirectToAuthorization'] = () => {},
) {
  let verifier = ''
  const csrf = randomUUID()
  const provider: OAuthClientProvider = {
    redirectUrl: state.redirect,
    clientMetadata: {
      client_name: 'AMC Desktop',
      redirect_uris: [state.redirect],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    },
    state: () => csrf,
    clientInformation: () => state.info,
    saveClientInformation: (info) => {
      state.info = info
    },
    tokens: () => state.tokens,
    saveTokens(tokens) {
      state.tokens = tokens
      writeCredentials(pairingFile(), state)
    },
    redirectToAuthorization,
    saveCodeVerifier: (code) => {
      verifier = code
    },
    codeVerifier: () => verifier,
  }
  return provider
}

async function pairT3(url: URL): Promise<Client> {
  const callback = createServer()
  await new Promise<void>((resolve, reject) => {
    callback.once('error', reject)
    callback.listen(0, '127.0.0.1', resolve)
  })
  const redirect = `http://127.0.0.1:${(callback.address() as AddressInfo).port}/callback`
  let finish = (_code: string | null) => {}
  const code = new Promise<string | null>((resolve) => {
    finish = resolve
  })
  const timer = setTimeout(() => finish(null), 180_000)
  const provider = oauthProvider({ url: url.href, redirect }, async (authorizationUrl) => {
    if (!['http:', 'https:'].includes(authorizationUrl.protocol))
      throw new Error('Invalid T3 sign-in URL')
    await shell.openExternal(authorizationUrl.href)
  })
  callback.on('request', async (req, res) => {
    const result = new URL(req.url ?? '/', redirect)
    if (
      result.pathname !== '/callback' ||
      result.searchParams.get('state') !== (await provider.state?.())
    ) {
      res.writeHead(400).end('Invalid T3 sign-in callback.')
      return
    }
    const value = result.searchParams.get('code')
    res
      .writeHead(value ? 200 : 400, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' })
      .end(value ? 'Return to AMC to choose a project.' : 'T3 sign-in was declined.')
    finish(value)
  })
  const transport = new StreamableHTTPClientTransport(url, { authProvider: provider })
  const client = new Client({ name: 'AMC Desktop', version: '1.0.0' })
  try {
    await client.connect(transport)
    return client
  } catch (error) {
    await transport.close()
    if (!(error instanceof UnauthorizedError)) throw error
    const value = await code
    if (!value) throw new Error('T3 sign-in was declined or timed out.')
    const authorized = new StreamableHTTPClientTransport(url, { authProvider: provider })
    // finishAuth uses discovery state on this transport, populated by the initial connection.
    await transport.finishAuth(value)
    await client.connect(authorized)
    return client
  } finally {
    clearTimeout(timer)
    callback.closeAllConnections()
    callback.close()
  }
}

async function t3Projects(address: string): Promise<T3Project[]> {
  const client = await t3Client(address)
  const projects: T3Project[] = []
  let cursor: number | null = null
  do {
    const response = await client.callTool({
      name: 't3_project_list',
      arguments: cursor === null ? {} : { cursor },
    })
    const page = response.structuredContent as
      | { projects: T3Project[]; nextCursor: number | null }
      | undefined
    if (response.isError || !page || !Array.isArray(page.projects))
      throw new Error('T3 could not list projects.')
    projects.push(
      ...page.projects
        .filter((project) => !project.archivedAt && !project.deletedAt)
        .map(({ id, title }) => ({ id, title })),
    )
    cursor = page.nextCursor ?? null
  } while (cursor !== null)
  return projects
}

async function launchInT3(address: string, request: T3Launch): Promise<T3Thread> {
  const client = await t3Client(address)
  try {
    const response = await client.callTool({ name: 't3_thread_launch', arguments: { ...request } })
    const thread = response.structuredContent as T3Thread | undefined
    if (!response.isError && thread?.threadId) return thread
  } catch {
    // Provider errors can echo the draft credential in the prompt.
  }
  throw new Error(
    'T3 could not confirm the launch. Retry, or check that AMC has Supervised access.',
  )
}

export function mcpLauncher(address: string): T3Launcher {
  const url = t3Url(address).href
  return {
    key: `mcp:${url}`,
    projects: () => t3Projects(address),
    launch: (request) => launchInT3(address, request),
  }
}
