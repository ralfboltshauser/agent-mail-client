import { randomUUID } from 'node:crypto'
import { hostname } from 'node:os'
import { setTimeout as delay } from 'node:timers/promises'
import {
  type AccountSummary,
  type AgentAction,
  Bucket,
  BucketInput,
  type Contact,
  doctorWarnings,
  type GmailAuthStartResponse,
  type Health,
  type Me,
  type MessageDetail,
  type MutationResponse,
  type OrganiseAction,
  type PairResponse,
  type SearchHit,
  type ThreadDetail,
  type ThreadList,
  type ThreadSummary,
} from '@amc/protocol'
import { Command } from 'commander'
import { authed, EngineError, request } from './client.ts'
import { readConfig, writeConfig } from './config.ts'
import { addImapAccount } from './imap-signin.ts'
import { loopbackSignIn } from './signin.ts'
import { runTriage } from './triage.ts'

declare const AMC_VERSION: string | undefined
const VERSION = typeof AMC_VERSION === 'string' ? AMC_VERSION : 'dev'

const program = new Command()
  .name('amc')
  .description('Agent Mail Client: work with your mail from the shell')
  .version(VERSION)

program
  .command('pair')
  .description('Pair this machine with an Engine using a code from `amc-engine pair` on the Host')
  .argument('<code>', 'the one-time pairing code')
  .requiredOption('--engine <url>', 'the Engine URL, e.g. https://host.tailnet.ts.net:4443')
  .option('--name <name>', 'a name for this device', hostname())
  .action(async (code: string, opts: { engine: string; name: string }) => {
    const res = await request<PairResponse>(opts.engine, '/v1/auth/pair', {
      method: 'POST',
      body: { code, deviceName: opts.name },
    })
    const path = writeConfig({ engineUrl: opts.engine, token: res.token })
    console.log(`Paired as "${opts.name}" with scopes: ${res.scopes.join(', ')}`)
    console.log(`Saved to ${path}`)
  })

program
  .command('status')
  .description('Show Engine health and token details')
  .option('--json', 'print JSON')
  .action(async (opts: { json?: boolean }) => {
    const api = authed(requireConfig())
    const [me, health] = await Promise.all([api<Me>('/v1/me'), api<Health>('/v1/health')])
    if (opts.json) {
      console.log(JSON.stringify({ me, health }, null, 2))
      return
    }
    console.log(
      `Engine ${health.version} · schema v${health.schemaVersion} · up ${formatDuration(health.uptimeSeconds)}`,
    )
    console.log(`Token  ${me.name} (${me.kind}) · ${me.scopes.join(', ')}`)
    console.log(`Database ${formatBytes(health.database.bytes)}`)
    if (health.lastBackup !== undefined) {
      const b = health.lastBackup
      console.log(
        `Backup ${b ? `${new Date(b.at).toISOString()} · ${formatBytes(b.bytes)}` : 'none yet'}`,
      )
    }
    for (const account of health.accounts ?? []) {
      const lag = account.syncLagSeconds
      console.log(
        `Account ${account.address} · ${account.status} · ${lag === null ? 'never synced' : `sync lag ${formatDuration(Math.floor(lag))}`}`,
      )
      if (account.lastError) console.log(`  ${account.lastError}`)
    }
    if (health.outboxDepth !== undefined) {
      console.log(`Outbox ${health.outboxDepth} pending`)
    }
    if (health.mutationQueueDepth !== undefined) {
      console.log(`Mutation queue ${health.mutationQueueDepth} pending`)
    }
    for (const disk of health.disks) {
      console.log(
        `Disk   ${disk.path}: ${formatBytes(disk.freeBytes)} free of ${formatBytes(disk.totalBytes)}`,
      )
    }
  })

program
  .command('doctor')
  .description('Warn about stale backups, slow sync, low disk space and Account errors')
  .action(async () => {
    const health = await authed(requireConfig())<Health>('/v1/health')
    const warnings = doctorWarnings(health)
    if (!warnings.length) return console.log('No health warnings.')
    for (const warning of warnings) console.warn(`Warning: ${warning}`)
  })

const account = program.command('account').description('Manage mail Accounts')

account
  .command('add')
  .description('Add an Account')
  .argument('<kind>', 'gmail or imap')
  .action(async (kind: string) => {
    if (kind === 'imap') {
      const res = await addImapAccount(requireConfig())
      console.log(
        `${res.created ? 'Added' : 'Signed in again to'} ${res.address}. Sync has started; watch it with \`amc accounts\`.`,
      )
      return
    }
    if (kind !== 'gmail') {
      console.error('Choose gmail or imap.')
      process.exit(2)
    }
    const api = authed(requireConfig())
    const { code, state } = await loopbackSignIn((redirectUri) =>
      api<GmailAuthStartResponse>('/v1/accounts/gmail/start', {
        method: 'POST',
        body: { redirectUri },
      }),
    )
    const res = await api<{ address: string; created: boolean }>('/v1/accounts/gmail/complete', {
      method: 'POST',
      body: { code, state },
    })
    console.log(
      `${res.created ? 'Added' : 'Signed in again to'} ${res.address}. Sync has started; watch it with \`amc accounts\`.`,
    )
  })

program
  .command('accounts')
  .description('List Accounts and their sync state')
  .option('--json', 'print JSON')
  .action(async (opts: { json?: boolean }) => {
    const { accounts } = await authed(requireConfig())<{ accounts: AccountSummary[] }>(
      '/v1/accounts',
    )
    if (opts.json) return printJson(accounts)
    if (accounts.length === 0)
      return console.log('No Accounts yet. Run `amc account add gmail` or `amc account add imap`.')
    for (const a of accounts) {
      const progress =
        a.backfill.phase && a.backfill.phase !== 'done'
          ? ` · backfill ${a.backfill.phase}: ${a.backfill.fetched}${a.backfill.estimatedTotal ? ` of ~${a.backfill.estimatedTotal}` : ''}`
          : ''
      const synced = a.lastSyncAt ? ` · synced ${ago(a.lastSyncAt)}` : ''
      console.log(
        `${a.address} (${a.kind}) · ${a.status} · ${a.messageCount} messages${progress}${synced}`,
      )
      if (a.lastError) console.log(`  ${a.lastError}`)
    }
  })

program
  .command('threads')
  .description('List Threads, newest first (Inbox by default)')
  .option('--all', 'all mail, not only the Inbox')
  .option('--unread', 'only unread')
  .option('--label <id>', 'only this Label id')
  .option('-n, --limit <n>', 'how many', '25')
  .option('--json', 'print JSON')
  .action(
    async (opts: {
      all?: boolean
      unread?: boolean
      label?: string
      limit: string
      json?: boolean
    }) => {
      const params = new URLSearchParams({ limit: opts.limit })
      if (opts.label) params.set('labelId', opts.label)
      else if (!opts.all) params.set('inbox', '1')
      if (opts.unread) params.set('unread', '1')
      const list = await authed(requireConfig())<ThreadList>(`/v1/threads?${params}`)
      if (opts.json) return printJson(list)
      printThreads(list.threads)
    },
  )

program
  .command('thread')
  .description('Show one Thread as text')
  .argument('<id>', 'Thread id')
  .option('--json', 'print JSON')
  .action(async (id: string, opts: { json?: boolean }) => {
    const api = authed(requireConfig())
    const t = await api<ThreadDetail>(`/v1/threads/${encodeURIComponent(id)}?deferBodies=1`)
    if (!opts.json) console.log(`# ${t.subject || '(no subject)'}\n`)
    for (const m of t.messages) {
      if (m.bodyText === null) {
        const detail = await api<MessageDetail>(`/v1/messages/${encodeURIComponent(m.id)}`)
        m.bodyText = detail.bodyText
      }
      if (opts.json) continue
      const from = m.from
        ? m.from.name
          ? `${m.from.name} <${m.from.address}>`
          : m.from.address
        : '(unknown)'
      console.log(`From: ${from}`)
      console.log(`To:   ${m.to.map((a) => a.address).join(', ')}`)
      console.log(`Date: ${new Date(m.sentAt).toLocaleString()}`)
      for (const a of m.attachments.filter((x) => !x.inline))
        console.log(`📎    ${a.filename} (${formatBytes(a.size)})`)
      console.log(`\n${m.bodyText}\n\n${'─'.repeat(60)}\n`)
    }
    if (opts.json) printJson(t)
  })

program
  .command('search')
  .description('Search the entire history (from:, to:, subject: work)')
  .argument('<query...>', 'what to look for')
  .option('-n, --limit <n>', 'how many', '20')
  .option('--json', 'print JSON')
  .action(async (words: string[], opts: { limit: string; json?: boolean }) => {
    const params = new URLSearchParams({ q: words.join(' '), limit: opts.limit })
    const { hits } = await authed(requireConfig())<{ hits: SearchHit[] }>(`/v1/search?${params}`)
    if (opts.json) return printJson(hits)
    if (hits.length === 0) return console.log('Nothing found.')
    printThreads(hits)
  })

async function organise(action: OrganiseAction) {
  const api = authed(requireConfig())
  const id = randomUUID()
  const post = (path: string, body: unknown) =>
    api<MutationResponse>(path, { method: 'POST', body })
  let result = (await post('/v1/mutations', { mutations: [{ id, action }] })).mutations[0]
  for (let attempt = 0; result?.status === 'pending' && attempt < 10; attempt++) {
    await delay(500)
    result = (await post('/v1/mutations/status', { ids: [id] })).mutations[0]
  }
  if (!result) throw new Error(`Mutation status missing for ${id}`)
  if (result.status === 'failed') throw new Error(result.error ?? 'Gmail writeback failed')
  if (result.status === 'partial') {
    printJson(result)
    process.exitCode = 1
    return
  }
  console.log(`${result.status === 'applied' ? 'Applied' : 'Queued'} · ${id}`)
}

for (const kind of ['archive', 'trash', 'read', 'unread', 'star', 'mute', 'undo'] as const) {
  program
    .command(kind)
    .argument('<thread>', 'Thread id')
    .option('--remove', 'restore from Trash, remove the star or unmute')
    .action((threadId: string, opts: { remove?: boolean }) => {
      if (opts.remove && !['trash', 'star', 'mute'].includes(kind))
        throw new Error(`--remove is not valid for ${kind}`)
      if (kind === 'archive' || kind === 'undo') return organise({ kind, threadId })
      if (kind === 'read' || kind === 'unread')
        return organise({ kind: 'read', threadId, value: kind === 'read' })
      return organise({ kind, threadId, value: !opts.remove })
    })
}

program
  .command('label')
  .argument('<thread>', 'Thread id')
  .argument('<label>', 'Label id')
  .option('--remove', 'remove the Label')
  .action((threadId: string, labelId: string, opts: { remove?: boolean }) =>
    organise({ kind: 'label', threadId, labelId, value: !opts.remove }),
  )

program
  .command('bucket')
  .argument('<thread>', 'Thread id')
  .argument('<bucket>', 'Reply, Action, Follow-up, Update, Later, "When I have time", or clear')
  .option('--reason <text>', 'one-line reason', 'Set manually')
  .action(async (threadId: string, value: string, opts: { reason: string }) => {
    const bucket = Bucket.options.find((name) => name.toLowerCase() === value.toLowerCase())
    if (!bucket && value.toLowerCase() !== 'clear')
      throw new Error(`Choose ${Bucket.options.join(', ')}, or clear`)
    const body = BucketInput.parse({ threadId, bucket: bucket ?? null, reason: opts.reason })
    await authed(requireConfig())('/v1/bucket', { method: 'PUT', body })
    console.log(bucket ? `Moved to ${bucket}` : 'Bucket cleared')
  })

program
  .command('triage')
  .description('Triage the newest untriaged Inbox Threads with Claude Code')
  .option('--account <id>', 'Account to triage (required if there are multiple)')
  .option('--dry-run', 'print proposed Buckets and reasons')
  .action(async (opts: { account?: string; dryRun?: boolean }) => {
    const controller = new AbortController()
    const interrupt = () => controller.abort(new Error('Triage interrupted'))
    process.once('SIGINT', interrupt)
    process.once('SIGTERM', interrupt)
    try {
      const config = requireConfig()
      let accountId = opts.account
      if (!accountId) {
        const { accounts } = await authed(config)<{ accounts: AccountSummary[] }>('/v1/accounts', {
          signal: controller.signal,
          redirect: 'error',
        })
        if (accounts.length !== 1 || !accounts[0])
          throw new Error('Choose an Account with --account <id> (see amc accounts --json)')
        accountId = accounts[0].id
      }
      const results = await runTriage(config, accountId, opts.dryRun === true, controller.signal)
      if (!results.length) console.log('No untriaged Inbox Threads.')
      else printJson(results)
    } finally {
      process.off('SIGINT', interrupt)
      process.off('SIGTERM', interrupt)
    }
  })

program
  .command('mutation-status')
  .argument('<id>', 'Mutation id')
  .action(async (id: string) => {
    const { mutations } = await authed(requireConfig())<MutationResponse>('/v1/mutations/status', {
      method: 'POST',
      body: { ids: [id] },
    })
    if (!mutations.length) throw new Error('Unknown mutation')
    printJson(mutations[0])
    if (mutations[0]?.status === 'failed' || mutations[0]?.status === 'partial')
      process.exitCode = 1
  })

const token = program.command('token').description('Tokens for Agents (MCP)')

token
  .command('create')
  .description('Create an Agent token and print how to connect Claude Code, Codex or T3 Code')
  .requiredOption('--agent <name>', 'who will use it, e.g. t3 or codex')
  .option('--scopes <list>', 'comma-separated: read, organize, draft', 'read,draft')
  .requiredOption('--expires <duration>', 'expiry in days, e.g. 30d (maximum 90d)')
  .option('--account <id>', 'limit this token to one Account')
  .action(async (opts: { agent: string; scopes: string; expires: string; account?: string }) => {
    const match = /^([1-9]\d?)d$/.exec(opts.expires)
    if (!match || Number(match[1]) > 90) throw new Error('Use an expiry between 1d and 90d')
    const config = requireConfig()
    const res = await authed(config)<{ id: string; token: string; scopes: string[] }>(
      '/v1/tokens',
      {
        method: 'POST',
        body: {
          name: opts.agent,
          scopes: opts.scopes
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean),
          expiresInDays: Number(match[1]),
          ...(opts.account ? { accountId: opts.account } : {}),
        },
      },
    )
    const url = new URL('/mcp', config.engineUrl).toString()
    console.log(
      `Created ${res.id} (${opts.agent}) for ${opts.expires} with scopes: ${res.scopes.join(', ')}. It is shown only once.\n`,
    )
    console.log('Claude Code:')
    console.log(
      `  claude mcp add --scope user --transport http amc ${url} --header "Authorization: Bearer ${res.token}"\n`,
    )
    console.log('Codex (~/.codex/config.toml):')
    console.log(
      `  [mcp_servers.amc]\n  url = "${url}"\n  http_headers = { Authorization = "Bearer ${res.token}" }\n`,
    )
    console.log(
      'Anything else: an MCP Streamable HTTP server at the URL above, with that Authorization header.',
    )
  })

token
  .command('list')
  .description('List tokens')
  .action(async () => {
    const { tokens } = await authed(requireConfig())<{
      tokens: {
        id: string
        kind: string
        name: string
        scopes: string[]
        last_used_at: number | null
        revoked_at: number | null
        expires_at: number | null
        account_id: string | null
      }[]
    }>('/v1/tokens')
    for (const t of tokens) {
      const state =
        t.kind === 'agent' && t.expires_at === null
          ? 'legacy token · re-issue with an expiry'
          : t.revoked_at
            ? 'revoked'
            : t.expires_at !== null && t.expires_at <= Date.now()
              ? 'expired'
              : t.last_used_at
                ? `used ${ago(t.last_used_at)}`
                : 'unused'
      console.log(
        `${t.id}  ${t.kind.padEnd(8)} ${t.name.padEnd(16)} ${t.scopes.join(',').padEnd(30)} ${state}${t.account_id ? ` · ${t.account_id}` : ''}`,
      )
    }
  })

token
  .command('revoke')
  .description('Revoke a token')
  .argument('<id>', 'token id')
  .action(async (id: string) => {
    await authed(requireConfig())(`/v1/tokens/${encodeURIComponent(id)}`, { method: 'DELETE' })
    console.log(`Revoked ${id}`)
  })

const agent = program.command('agent').description('Review Agent activity')

agent
  .command('log')
  .description('List recent Agent actions')
  .option('--before <cursor>', 'show the next page using nextBefore')
  .action(async ({ before }: { before?: string }) => {
    const query = before ? `?before=${encodeURIComponent(before)}` : ''
    printJson(
      await authed(requireConfig())<{ actions: AgentAction[]; nextBefore: number | null }>(
        `/v1/agent/log${query}`,
      ),
    )
  })

agent
  .command('undo')
  .description('Undo an Agent organize action')
  .argument('<id>', 'action id from amc agent log')
  .action(async (id: string) => {
    printJson(
      await authed(requireConfig())<MutationResponse>(
        `/v1/agent/log/${encodeURIComponent(id)}/undo`,
        { method: 'POST' },
      ),
    )
  })

program
  .command('contacts')
  .description('Find people you have mailed with')
  .argument('<query>', 'part of a name or address')
  .action(async (query: string) => {
    const { contacts } = await authed(requireConfig())<{ contacts: Contact[] }>(
      `/v1/contacts?q=${encodeURIComponent(query)}`,
    )
    if (contacts.length === 0) return console.log('Nobody found.')
    for (const c of contacts)
      console.log(
        `${(c.name ?? '').padEnd(28)} ${c.address}  (${c.sentCount} sent, ${c.receivedCount} received)`,
      )
  })

function printThreads(threads: ThreadSummary[]) {
  if (threads.length === 0) return console.log('No Threads.')
  for (const t of threads) {
    const who = t.participants
      .map((p) => p.name ?? p.address)
      .slice(0, 3)
      .join(', ')
    const flags = `${t.unreadCount > 0 ? '●' : ' '}${t.starred ? '★' : ' '}${t.hasAttachments ? '📎' : '  '}`
    const count = t.messageCount > 1 ? ` (${t.messageCount})` : ''
    console.log(
      `${flags} ${shortDate(t.lastMessageAt).padEnd(6)} ${truncate(who, 24).padEnd(24)} ${truncate(t.subject || '(no subject)', 60)}${count}`,
    )
    console.log(`        ${t.id}`)
  }
}

function printJson(value: unknown) {
  console.log(JSON.stringify(value, null, 2))
}

function truncate(text: string, max: number) {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

function shortDate(ms: number) {
  const d = new Date(ms)
  const now = new Date()
  if (d.toDateString() === now.toDateString())
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  if (d.getFullYear() === now.getFullYear())
    return d.toLocaleDateString([], { month: 'short', day: 'numeric' })
  return String(d.getFullYear())
}

function ago(ms: number) {
  const s = Math.round((Date.now() - ms) / 1000)
  if (s < 60) return `${s}s ago`
  if (s < 3600) return `${Math.round(s / 60)}m ago`
  return `${Math.round(s / 3600)}h ago`
}

function requireConfig() {
  const config = readConfig()
  if (!config) {
    console.error(
      'Not paired. Run `amc-engine pair` on the Host, then `amc pair <code> --engine <url>`.',
    )
    process.exit(1)
  }
  return config
}

export function formatBytes(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit++
  }
  return `${value.toFixed(value < 10 && unit > 0 ? 1 : 0)} ${units[unit]}`
}

function formatDuration(seconds: number): string {
  if (seconds < 120) return `${seconds}s`
  if (seconds < 7200) return `${Math.round(seconds / 60)}m`
  if (seconds < 172800) return `${Math.round(seconds / 3600)}h`
  return `${Math.round(seconds / 86400)}d`
}

async function main() {
  const args = process.argv.slice(2)
  const [command] = args
  // Only command discovery and Snooze itself need the Engine's feature settings.
  if (!command || ['help', '-h', '--help', 'snooze'].includes(command)) {
    const config = readConfig()
    const me = config
      ? await authed(config)<Me>('/v1/me', { signal: AbortSignal.timeout(1500) }).catch(() => null)
      : null
    if (me?.features?.snooze === true) {
      program
        .command('snooze')
        .argument('<thread>', 'Thread id')
        .argument('<until>', 'ISO date and time')
        .option('--if-no-reply', 'cancel the Snooze if a reply arrives first')
        .action((threadId: string, until: string, opts: { ifNoReply?: boolean }) => {
          const timestamp = Date.parse(until)
          if (!Number.isFinite(timestamp) || timestamp <= Date.now())
            throw new Error('Choose a future ISO date and time')
          return organise({ kind: 'snooze', threadId, until: timestamp, noReply: opts.ifNoReply })
        })
    }
  }
  await program.parseAsync()
}

main().catch((error: unknown) => {
  if (error instanceof EngineError) console.error(`Error: ${error.message}`)
  else console.error(error)
  process.exit(1)
})
