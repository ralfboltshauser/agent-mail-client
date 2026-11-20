import { hostname } from 'node:os'
import type {
  AccountSummary,
  GmailAuthStartResponse,
  Health,
  Me,
  PairResponse,
  SearchHit,
  ThreadDetail,
  ThreadList,
  ThreadSummary,
} from '@amc/protocol'
import { Command } from 'commander'
import { authed, EngineError, request } from './client.ts'
import { readConfig, writeConfig } from './config.ts'
import { loopbackSignIn } from './signin.ts'

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
  .description('Show the Engine version, storage and who this token is')
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
    for (const disk of health.disks) {
      console.log(
        `Disk   ${disk.path}: ${formatBytes(disk.freeBytes)} free of ${formatBytes(disk.totalBytes)}`,
      )
    }
  })

const account = program.command('account').description('Manage mail Accounts')

account
  .command('add')
  .description('Add an Account (opens a browser to sign in)')
  .argument('<kind>', 'gmail')
  .action(async (kind: string) => {
    if (kind !== 'gmail') {
      console.error('Only gmail is supported so far.')
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
      return console.log('No Accounts yet. Add one with `amc account add gmail`.')
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
    const t = await authed(requireConfig())<ThreadDetail>(`/v1/threads/${encodeURIComponent(id)}`)
    if (opts.json) return printJson(t)
    console.log(`# ${t.subject || '(no subject)'}\n`)
    for (const m of t.messages) {
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

program.parseAsync().catch((error: unknown) => {
  if (error instanceof EngineError) console.error(`Error: ${error.message}`)
  else console.error(error)
  process.exit(1)
})
