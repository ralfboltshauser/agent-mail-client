import { randomUUID } from 'node:crypto'
import { hostname } from 'node:os'
import { setTimeout as delay } from 'node:timers/promises'
import { cliCommand, newRunId } from '@amc/observability'
import {
  type AccountSummary,
  type AgentAction,
  Bucket,
  BucketByIdInput,
  BucketByIdReviewInput,
  BucketId,
  BucketInput,
  BucketReviewInput,
  bucketLabels,
  type Contact,
  doctorWarnings,
  type GmailAuthStartResponse,
  type Health,
  MAIL_SEARCH_PAGE_SIZE,
  type Me,
  type MessageDetail,
  type MutationResponse,
  type OrganiseAction,
  type OwnerActionStatus,
  type PairResponse,
  type SearchHit,
  type ThreadDetail,
  type ThreadList,
  type ThreadSummary,
} from '@amc/protocol'
import { Command, CommanderError } from 'commander'
import { z } from 'zod'
import { agentBucketCatalog, ownerBucketCatalog, registerBucketCommands } from './buckets.ts'
import { authed, request } from './client.ts'
import { readConfig, writeConfig } from './config.ts'
import { registerDiagnosticsCommands } from './diagnostics.ts'
import { registerDraftCommands } from './drafts.ts'
import { addImapAccount } from './imap-signin.ts'
import { addThread, agentOrganize, registerMailCommands } from './mail-commands.ts'
import { mailTool } from './mcp.ts'
import { cliContext, cliFailure, closeClientLogs, retainFailureSource } from './observability.ts'
import { loopbackSignIn } from './signin.ts'
import { registerSkillCommands } from './skills.ts'
import { printOwnerAction, registerSmartInboxCommands } from './smart-inbox.ts'
import { describeTriageFailure, runTriage, TriageFailure } from './triage.ts'

declare const AMC_VERSION: string | undefined
const VERSION = typeof AMC_VERSION === 'string' ? AMC_VERSION : 'dev'
const BucketWriteResult = z.looseObject({ updated: z.boolean() })
const scopedCommands = new Set([
  'whoami',
  'accounts',
  'threads',
  'thread',
  'message',
  'search',
  'link.thread',
  'link.search',
  'contacts',
  'labels',
  'archive',
  'read',
  'unread',
  'star',
  'mute',
  'label',
  'bucket',
  'buckets.list',
  'agent.status',
  'triage.untriaged',
  'senders.suggest',
  'reply',
  'draft.create',
  'draft.list',
  'draft.show',
  'draft.update',
  'draft.discard',
])

const program = new Command()
  .name('amc')
  .description('Agent Mail Client: work with your mail from the shell')
  .version(VERSION)
  .option('--as-agent', 'use an explicit scoped agent grant from AMC_TOKEN')
  .exitOverride()
  .configureOutput({
    outputError: (message, write) =>
      write(
        ['logs', 'diagnostics'].includes(process.argv[2] ?? '')
          ? 'Invalid diagnostics command options.\n'
          : message,
      ),
  })
  .hook('preAction', (_program, action) => {
    const names = [action.name()]
    for (let parent = action.parent; parent && parent !== program; parent = parent.parent)
      names.unshift(parent.name())
    const context = cliContext.getStore()
    if (context) context.command = cliCommand(names.join('.'))
    if (agentMode()) {
      if (!process.env.AMC_TOKEN?.trim()) throw new Error('Agent mode requires AMC_TOKEN.')
      if (!scopedCommands.has(names.join('.')))
        throw new Error('This command is unavailable in agent mode.')
    }
  })

const agentMode = () => program.opts<{ asAgent?: boolean }>().asAgent === true

registerDiagnosticsCommands(program, readConfig)
registerSkillCommands(program)
registerBucketCommands(program, requireConfig, agentMode)
registerDraftCommands(program, requireConfig, agentMode)

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
    if (health.gmailPubSub) {
      const { enabled, pullHealthy, lastNotificationAt, pullErrorCount, lastPullError } =
        health.gmailPubSub
      const state = enabled
        ? pullHealthy
          ? 'pulling'
          : 'waiting for a successful pull'
        : 'disabled'
      const lastNotification =
        lastNotificationAt === null ? 'none yet' : new Date(lastNotificationAt).toISOString()
      console.log(
        `Gmail Pub/Sub ${state} · last notification ${lastNotification} · ${pullErrorCount} pull errors`,
      )
      if (lastPullError) {
        console.log(
          `  Last pull error ${new Date(lastPullError.at).toISOString()} · ${lastPullError.message}`,
        )
      }
    }
    for (const account of health.accounts ?? []) {
      const lag = account.syncLagSeconds
      console.log(
        `Account ${account.address} · ${account.status} · ${lag === null ? 'never synced' : `sync lag ${formatDuration(Math.floor(lag))}`}`,
      )
      if (account.lastError) console.log(`  ${account.lastError}`)
      if (account.gmailPush) {
        const { watchExpiresAt, lastNotificationAt, pollIntervalMs } = account.gmailPush
        const expiry =
          watchExpiresAt === null ? 'unavailable' : new Date(watchExpiresAt).toISOString()
        const lastNotification =
          lastNotificationAt === null ? 'none yet' : new Date(lastNotificationAt).toISOString()
        const poll = pollIntervalMs === null ? 'inactive' : `every ${pollIntervalMs / 1000}s`
        console.log(
          `  Gmail watch expiry ${expiry} · last notification ${lastNotification} · poll ${poll}`,
        )
      }
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
    if (health.lastBackup === undefined)
      warnings.unshift('Backup status is unavailable from this Engine.')
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
      throw new CommanderError(2, 'amc.invalidInput', 'Choose gmail or imap.')
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
    if (agentMode()) {
      const accounts = await mailTool<Pick<AccountSummary, 'id' | 'address' | 'status'>[]>(
        requireConfig(),
        true,
        'list_accounts',
      )
      if (opts.json) return printJson(accounts)
      for (const account of accounts)
        console.log(`${account.id}\t${account.address}\t${account.status}`)
      return
    }
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
  .option('--account <id>', 'Account ID')
  .option('--before <cursor>', 'continue from the previous nextBefore value')
  .option('-n, --limit <n>', 'how many', '25')
  .option('--json', 'print JSON')
  .action(
    async (opts: {
      all?: boolean
      unread?: boolean
      label?: string
      account?: string
      before?: string
      limit: string
      json?: boolean
    }) => {
      if (agentMode()) {
        const list = await mailTool<ThreadList>(requireConfig(), true, 'list_threads', {
          view: opts.all ? 'all' : 'inbox',
          label_id: opts.label,
          account_id: opts.account,
          unread: opts.unread,
          before: opts.before === undefined ? undefined : Number(opts.before),
          limit: Number(opts.limit),
        })
        if (opts.json) return printJson(list)
        printThreads(list.threads)
        return
      }
      const params = new URLSearchParams({ limit: opts.limit })
      if (opts.label) params.set('labelId', opts.label)
      else if (!opts.all) params.set('inbox', '1')
      if (opts.unread) params.set('unread', '1')
      if (opts.account) params.set('accountId', opts.account)
      if (opts.before) params.set('before', opts.before)
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
    const config = requireConfig()
    const isAgent = agentMode()
    const api = authed(config)
    const t = isAgent
      ? await mailTool<ThreadDetail>(config, true, 'get_thread', { thread_id: id })
      : await api<ThreadDetail>(`/v1/threads/${encodeURIComponent(id)}?deferBodies=1`)
    if (!opts.json) console.log(`# ${t.subject || '(no subject)'}\n`)
    for (const m of t.messages) {
      if (!isAgent && m.bodyText === null) {
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
  .description('Search synced mail (from:, to:, cc:, subject:, after:, before:)')
  .argument('<query...>', 'what to look for')
  .option('--account <id>', 'Account ID')
  .option('-n, --limit <n>', 'page size', '20')
  .option('--offset <n>', 'number of matching threads to skip', '0')
  .option('--json', 'print JSON')
  .action(
    async (
      words: string[],
      opts: { account?: string; limit: string; offset: string; json?: boolean },
    ) => {
      const query = words.join(' ')
      const limit = Number(opts.limit)
      const offset = Number(opts.offset)
      const max = agentMode() ? MAIL_SEARCH_PAGE_SIZE : 200
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > max)
        throw new Error(`Search limit must be between 1 and ${max}.`)
      if (!Number.isSafeInteger(offset) || offset < 0)
        throw new Error('Search offset must be a nonnegative integer.')
      const params = new URLSearchParams({ q: query, limit: opts.limit, offset: opts.offset })
      if (opts.account) params.set('accountId', opts.account)
      const config = requireConfig()
      const hits = agentMode()
        ? await mailTool<SearchHit[]>(config, true, 'search', {
            query,
            account_id: opts.account,
            limit,
            offset,
          })
        : (await authed(config)<{ hits: SearchHit[] }>(`/v1/search?${params}`)).hits
      if (opts.json) return printJson(hits)
      if (hits.length === 0) return console.log('Nothing found.')
      printThreads(hits)
    },
  )

async function organise(action: OrganiseAction, json?: boolean) {
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
  if (json) {
    printJson(result)
    if (result.status === 'failed' || result.status === 'partial') process.exitCode = 1
    return
  }
  if (result.status === 'failed') throw new Error(result.error ?? 'Organise writeback failed')
  if (result.status === 'partial') {
    printJson(result)
    process.exitCode = 1
    return
  }
  if (result.status === 'applied' && result.superseded?.length) {
    console.log(`Skipped ${result.superseded.length} changed message(s) · ${id}`)
    return
  }
  if (result.status === 'pending' && result.error) {
    console.log(`${result.error} · cleanup queued · ${id}`)
    return
  }
  console.log(`${result.status === 'applied' ? 'Applied' : 'Queued'} · ${id}`)
}

for (const kind of ['archive', 'trash', 'read', 'unread', 'star', 'mute', 'undo'] as const) {
  program
    .command(kind)
    .argument('<thread>', 'Thread id')
    .option('--remove', 'restore from Trash, remove the star or unmute')
    .option('--thread <id>', 'additional Thread ID for an agent batch, repeatable', addThread)
    .option('--json', 'print JSON')
    .action((threadId: string, opts: { remove?: boolean; thread?: string[]; json?: boolean }) => {
      if (opts.remove && !['trash', 'star', 'mute'].includes(kind))
        throw new Error(`--remove is not valid for ${kind}`)
      if (agentMode()) {
        if (kind === 'trash' || kind === 'undo' || (kind === 'mute' && opts.remove))
          throw new Error('This operation is unavailable with an agent grant.')
        const tool =
          kind === 'read'
            ? 'mark_read'
            : kind === 'unread'
              ? 'mark_unread'
              : kind === 'star' && opts.remove
                ? 'unstar'
                : kind
        return agentOrganize(requireConfig(), tool, [threadId, ...(opts.thread ?? [])], opts.json)
      }
      if (opts.thread?.length) throw new Error('Additional threads require --as-agent.')
      if (kind === 'archive' || kind === 'undo') return organise({ kind, threadId }, opts.json)
      if (kind === 'read' || kind === 'unread')
        return organise({ kind: 'read', threadId, value: kind === 'read' }, opts.json)
      return organise({ kind, threadId, value: !opts.remove }, opts.json)
    })
}

program
  .command('label')
  .argument('<thread>', 'Thread id')
  .argument('<label>', 'Label id or IMAP destination folder id')
  .option('--remove', 'remove the Label')
  .option('--thread <id>', 'additional Thread ID for an agent batch, repeatable', addThread)
  .option('--json', 'print JSON')
  .action(
    (
      threadId: string,
      labelId: string,
      opts: { remove?: boolean; thread?: string[]; json?: boolean },
    ) => {
      if (agentMode())
        return agentOrganize(
          requireConfig(),
          opts.remove ? 'remove_label' : 'add_label',
          [threadId, ...(opts.thread ?? [])],
          opts.json,
          labelId,
        )
      if (opts.thread?.length) throw new Error('Additional threads require --as-agent.')
      return organise({ kind: 'label', threadId, labelId, value: !opts.remove }, opts.json)
    },
  )

program
  .command('bucket')
  .argument('<thread>', 'Thread id')
  .argument('<bucket>', 'Bucket name, stable ID, or clear')
  .option('--reason <text>', 'one-line reason', 'Set manually')
  .option('--id', 'use the ID-aware contract when clearing or replacing a custom assignment')
  .option('--review <revision>', 'record an owner correction at this Thread revision')
  .option('--action-id <id>', 'reuse this review action UUID on retry')
  .option('--only-untriaged', 'skip if already triaged or outside the Inbox (agent only)')
  .option('--json', 'print JSON')
  .action(
    async (
      threadId: string,
      value: string,
      opts: {
        reason: string
        review?: string
        actionId?: string
        id?: boolean
        onlyUntriaged?: boolean
        json?: boolean
      },
    ) => {
      const bucket = Bucket.options.find((name) => name.toLowerCase() === value.toLowerCase())
      const config = requireConfig()
      const clear = value.toLowerCase() === 'clear'
      const base = { threadId, reason: opts.reason }
      let input:
        | { threadId: string; reason: string; bucket: Bucket | null }
        | z.infer<typeof BucketByIdInput>
      if (opts.id && clear) input = { ...base, bucketId: null }
      else if (bucket && opts.id) input = { ...base, bucketId: bucketLabels[bucket] }
      else if (bucket || clear) input = { ...base, bucket: bucket ?? null }
      else {
        const id = BucketId.safeParse(value)
        const definitions = id.success
          ? []
          : agentMode()
            ? (await agentBucketCatalog(config)).definitions
            : (await ownerBucketCatalog(config)).definitions.filter(({ archived }) => !archived)
        const match = id.success
          ? id.data
          : definitions.find(
              ({ name }) =>
                name.normalize('NFKC').toLowerCase() === value.normalize('NFKC').toLowerCase(),
            )?.id
        if (!match) throw new Error('Bucket not found. Check its name or stable ID.')
        input = { ...base, bucketId: match }
      }
      const byId = 'bucketId' in input
      const label = bucket ?? value
      if (agentMode()) {
        if (opts.review !== undefined || opts.actionId)
          throw new Error('Owner review corrections are unavailable with an agent grant.')
        const result = await mailTool(
          requireConfig(),
          true,
          byId ? 'set_bucket_by_id' : 'set_bucket',
          {
            ...(byId ? BucketByIdInput.parse(input) : BucketInput.parse(input)),
            onlyUntriaged: opts.onlyUntriaged,
          },
          { write: true, result: BucketWriteResult },
        )
        if (opts.json) return printJson(result)
        console.log(
          result.updated ? (clear ? 'Bucket cleared' : `Moved to ${label}`) : 'Thread skipped.',
        )
        return
      }
      if (opts.onlyUntriaged) throw new Error('--only-untriaged requires --as-agent.')
      if (opts.review !== undefined) {
        if (!/^\d+$/.test(opts.review))
          throw new Error('Expected a Thread revision from amc triage queue')
        const body = (byId ? BucketByIdReviewInput : BucketReviewInput).parse({
          ...input,
          intent: 'review',
          expectedRevision: Number(opts.review),
          clientActionId: opts.actionId ?? randomUUID(),
        })
        const result = await authed(requireConfig())<OwnerActionStatus>('/v1/bucket', {
          method: 'PUT',
          body,
        })
        if (opts.json) return printJson(result)
        printOwnerAction(result)
        return
      }
      if (opts.actionId) throw new Error('--action-id requires --review')
      const body = (byId ? BucketByIdInput : BucketInput).parse(input)
      const result = await authed(requireConfig())('/v1/bucket', { method: 'PUT', body })
      if (opts.json) return printJson(result)
      console.log(clear ? 'Bucket cleared' : `Moved to ${label}`)
    },
  )

const triage = program
  .command('triage')
  .description('Triage the newest untriaged Inbox Threads with Claude Code')
  .option('--account <id>', 'Account to triage (required if there are multiple)')
  .option('--dry-run', 'print proposed Buckets and reasons')
  .option('--recent', 'only include Threads with delivery in the last 24 hours')
  .action(async (opts: { account?: string; dryRun?: boolean; recent?: boolean }) => {
    const context = cliContext.getStore()
    if (context) context.runId = newRunId()
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
        }).catch((cause: unknown) => {
          throw triageCommandError(new TriageFailure('engine-prepare', { cause }))
        })
        if (accounts.length !== 1 || !accounts[0])
          throw new Error('Choose an Account with --account <id> (see amc accounts --json)')
        accountId = accounts[0].id
      }
      const results = await runTriage(
        config,
        accountId,
        opts.dryRun === true,
        controller.signal,
        undefined,
        opts.recent === true,
      ).catch((error: unknown) => {
        throw triageCommandError(error)
      })
      if (!results) console.log('Triage is already running.')
      else if (!results.length) console.log('No untriaged Inbox Threads.')
      else printJson(results)
    } finally {
      process.off('SIGINT', interrupt)
      process.off('SIGTERM', interrupt)
    }
  })

function triageCommandError(error: unknown) {
  // The top-level debug reporter inspects nested Error causes.
  const failures = error instanceof AggregateError ? error.errors : [error]
  const message = failures
    .map(describeTriageFailure)
    .map(({ className, message }) =>
      process.env.AMC_DEBUG === '1' ? `${className}: ${message}` : message,
    )
    .join('\n')
  const cause = failures[0] instanceof TriageFailure ? failures[0].cause : undefined
  return retainFailureSource(new Error(message), cause ?? failures[0])
}

const senders = registerSmartInboxCommands(program, triage, requireConfig)

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

const token = program.command('token').description('Manage agent grants for MCP and the CLI')

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
    console.log('AMC CLI: supply the issued bearer in AMC_TOKEN and run amc --as-agent <command>.')
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
  .option('-n, --limit <n>', 'how many')
  .option('--json', 'print JSON')
  .action(async (query: string, opts: { limit?: string; json?: boolean }) => {
    const config = requireConfig()
    const params = new URLSearchParams({ q: query })
    if (opts.limit !== undefined) params.set('limit', opts.limit)
    const contacts = agentMode()
      ? await mailTool<Contact[]>(config, true, 'search_contacts', {
          query,
          limit: opts.limit === undefined ? undefined : Number(opts.limit),
        })
      : (await authed(config)<{ contacts: Contact[] }>(`/v1/contacts?${params}`)).contacts
    if (opts.json) return printJson(contacts)
    if (contacts.length === 0) return console.log('Nobody found.')
    for (const c of contacts)
      console.log(
        `${(c.name ?? '').padEnd(28)} ${c.address}  (${c.sentCount} sent, ${c.receivedCount} received)`,
      )
  })

registerMailCommands(program, triage, senders, agent, requireConfig, agentMode, printThreads)

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
    throw new Error(
      'Not paired. Run `amc-engine pair` on the Host, then `amc pair <code> --engine <url>`.',
    )
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
      ? await authed(config)<Me>('/v1/me', { signal: AbortSignal.timeout(1500) }).catch(
          (error: unknown) => {
            cliFailure('discovery', error)
            return null
          },
        )
      : null
    if (me?.features?.snooze === true) {
      program
        .command('snooze')
        .argument('<thread>', 'Thread id')
        .argument('<until>', 'ISO date and time')
        .option('--if-no-reply', 'wake early if a reply arrives')
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

const command = cliCommand(process.argv[2] ?? 'help')
await cliContext.run({ command }, async () => {
  try {
    await main()
    if (process.exitCode) {
      const details = cliFailure(
        'command',
        new Error('Command returned an incomplete result'),
        'partial',
      )
      console.error(`Details: ${details.class} · ${details.id}`)
    }
  } catch (error) {
    if (error instanceof CommanderError && error.exitCode === 0) return
    const details = cliFailure(
      'command',
      error,
      error instanceof CommanderError ? 'rejected' : undefined,
    )
    if (!(error instanceof CommanderError) || error.code === 'amc.invalidInput') {
      if (process.env.AMC_DEBUG === '1') console.error(error)
      else console.error(`Error: ${error instanceof Error ? error.message : String(error)}`)
    }
    console.error(`Details: ${details.class} · ${details.id}`)
    process.exitCode = error instanceof CommanderError ? error.exitCode : 1
  } finally {
    await closeClientLogs()
  }
})
