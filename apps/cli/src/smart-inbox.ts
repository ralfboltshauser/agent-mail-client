import { randomUUID } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { domainToASCII } from 'node:url'
import {
  type FilteredPage,
  FilterReviewInput,
  type OwnerActionStatus,
  type SenderAvatarResults,
  SenderDecision,
  type SenderList,
  SenderListQuery,
  type TriageForgetResult,
  type TriageHistoryPage,
  TriageHistoryQuery,
  type TriageQueuePage,
  TriageQueueQuery,
} from '@amc/protocol'
import type { Command } from 'commander'
import { authed, response } from './client.ts'
import type { CliConfig } from './config.ts'

async function readPrivateReason(path: string) {
  if (path !== '-') return (await readFile(path, 'utf8')).trim()
  let value = ''
  process.stdin.setEncoding('utf8')
  for await (const chunk of process.stdin) value += chunk
  return value.trim()
}

export function printOwnerAction(action: OwnerActionStatus, undo = false) {
  const { ownerReason: _ownerReason, ...status } = action
  console.log(JSON.stringify(status, null, 2))
  const outcomes = undo ? [action.undo?.status] : [action.status, action.undo?.status ?? 'applied']
  if (outcomes.some((outcome) => !outcome || ['failed', 'partial', 'superseded'].includes(outcome)))
    process.exitCode = 1
}

function endpoint(path: string, query: Record<string, string | number | undefined>) {
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(query))
    if (value !== undefined) params.set(key, String(value))
  return `${path}?${params}`
}

async function senderRevision(api: ReturnType<typeof authed>, accountId: string, address: string) {
  const at = address.lastIndexOf('@')
  const canonical =
    at < 1
      ? address
      : `${address.slice(0, at).toLowerCase()}@${domainToASCII(address.slice(at + 1))}`
  let cursor: string | undefined
  do {
    const page = await api<SenderList>(endpoint('/v1/senders', { accountId, cursor, limit: 100 }))
    const match = page.rows.find(
      (sender) => sender.accountId === accountId && sender.address === canonical,
    )
    if (match) return match.revision
    cursor = page.cursor ?? undefined
  } while (cursor)
  return 0
}

export function registerSmartInboxCommands(
  program: Command,
  triage: Command,
  config: () => CliConfig,
) {
  triage
    .command('history')
    .description('List the owner decision log')
    .option('--before <sequence>', 'continue before this sequence')
    .option('--limit <n>', 'page size (1–100)')
    .option('--include-reasons', 'explicitly show private reasons on stdout')
    .action(async (_opts, command: Command) => {
      const { account, before, limit, includeReasons } = command.optsWithGlobals()
      const query = TriageHistoryQuery.parse({
        accountId: account,
        before,
        limit,
        includeReasons: includeReasons ? '1' : undefined,
      })
      const page = await authed(config())<TriageHistoryPage>(endpoint('/v1/triage/events', query))
      console.log(JSON.stringify(page, null, 2))
    })

  triage
    .command('export')
    .description('Write an owner-preferences JSONL file')
    .requiredOption('--output <path>', 'new local file to create')
    .option('--include-reasons', 'include private reasons in the file')
    .action(async (_opts, command: Command) => {
      const { account, output, includeReasons = false } = command.optsWithGlobals()
      const { engineUrl, token } = config()
      const result = await response(engineUrl, '/v1/triage/events/export', {
        method: 'POST',
        redirect: 'error',
        token,
        body: { accountId: account, includeReasons },
      })
      if (!result.headers.get('Content-Type')?.startsWith('application/x-ndjson'))
        throw new Error('Engine did not return an owner-preferences export')
      await writeFile(output, Buffer.from(await result.arrayBuffer()), { flag: 'wx', mode: 0o600 })
      console.log('Triage export saved.')
    })

  triage
    .command('forget')
    .description('Permanently erase a decision and its private learning data')
    .argument('<event-id>')
    .requiredOption('--confirm', 'confirm erasure')
    .action(async (id: string) => {
      const result = await authed(config())<TriageForgetResult | null>(
        `/v1/triage/events/${encodeURIComponent(id)}`,
        { method: 'DELETE', redirect: 'error' },
      )
      const status =
        result?.physicalPurge === 'pending'
          ? 'Forget done. Physical purge pending. Check amc triage history for updates.'
          : result?.physicalPurge === 'completed'
            ? 'Forget done. Physical purge completed.'
            : 'Decision forgotten.'
      console.log(`${status} Older backups and existing exports can still contain it.`)
    })

  triage
    .command('queue')
    .description('List the owner review queue')
    .option('--limit <n>', 'page size (1–100)')
    .option('--cursor <cursor>', 'continue the snapshot')
    .option('--json', 'print JSON')
    .action(async (_opts, command: Command) => {
      const { account, limit, cursor, json } = command.optsWithGlobals()
      const query = TriageQueueQuery.parse({
        accountId: account,
        limit,
        cursor,
        bucketCatalogVersion: '1',
      })
      const page = await authed(config())<TriageQueuePage>(endpoint('/v1/triage/queue', query))
      if (json) console.log(JSON.stringify(page, null, 2))
      else {
        console.log(`Snapshot ${page.revision}`)
        for (const card of page.cards) console.log(JSON.stringify(card))
        if (page.cursor) console.log(`Next cursor ${page.cursor}`)
      }
    })

  triage
    .command('filtered')
    .description('List Filtered Threads')
    .option('--account <id>', 'filter by Account ID')
    .option('--cursor <cursor>', 'continue from this cursor')
    .option('--limit <n>', 'page size (1–100)')
    .action(async (_opts, command: Command) => {
      const { account, cursor, limit } = command.optsWithGlobals()
      const page = await authed(config())<FilteredPage>(
        endpoint('/v1/filtered', { accountId: account, cursor, limit }),
      )
      console.log(JSON.stringify(page, null, 2))
    })
  for (const command of ['filter', 'restore'] as const) {
    triage
      .command(command)
      .argument('<thread-id>')
      .option('--revision <n>', 'expected Thread revision from triage queue or filtered list')
      .option('--action-id <id>', 'reuse this action UUID on retry')
      .option('--reason-file <path>', 'read the private reason from a file or - for stdin')
      .action(async (threadId, { revision, actionId, reasonFile }) => {
        const api = authed(config())
        if (!revision && (command === 'filter' || actionId))
          throw new Error('Supply the original --revision for this decision')
        if (revision !== undefined && !/^\d+$/.test(revision))
          throw new Error('Expected a nonnegative Thread revision')
        const expectedRevision =
          revision === undefined
            ? (await api<FilteredPage>(endpoint('/v1/filtered', { threadId, limit: 1 }))).threads[0]
                ?.revision
            : Number(revision)
        if (expectedRevision === undefined) throw new Error('Thread is unavailable in Filtered')
        const body = FilterReviewInput.parse({
          threadId,
          expectedRevision,
          clientActionId: actionId ?? randomUUID(),
          reason: reasonFile ? await readPrivateReason(reasonFile) : undefined,
          decision: command === 'filter' ? 'filter.filtered' : 'filter.keep',
          source: 'cli',
        })
        printOwnerAction(
          await api<OwnerActionStatus>('/v1/filtered/decisions', { method: 'POST', body }),
        )
      })
  }
  triage
    .command('undo')
    .argument('<action-id>')
    .action(async (id) => {
      const result = await authed(config())<OwnerActionStatus>(
        `/v1/owner-actions/${encodeURIComponent(id)}/undo`,
        { method: 'POST' },
      )
      printOwnerAction(result, true)
    })

  const senders = program.command('senders').description('Review Account Sender rules')
  senders
    .command('list')
    .option('--account <id>', 'filter by Account ID')
    .option('--status <status>', 'unresolved, new, known, or blocked')
    .option('--limit <n>', 'page size (1–100)')
    .option('--cursor <cursor>', 'start after this cursor')
    .option('--json', 'print JSON')
    .action(async ({ account, status, limit, cursor, json }) => {
      const query = SenderListQuery.parse({ accountId: account, status, limit, cursor })
      const page = await authed(config())<SenderList>(endpoint('/v1/senders', query))
      if (json)
        console.log(
          JSON.stringify({ ...page, rows: page.rows.map(({ reason: _, ...row }) => row) }, null, 2),
        )
      else {
        for (const row of page.rows) {
          console.log(`${row.accountId}\t${row.address}\t${row.status}\t${row.revision}`)
          for (const suggestion of row.suggestions) console.log(`  ${JSON.stringify(suggestion)}`)
        }
        if (page.cursor) console.log(`Next cursor ${page.cursor}`)
      }
    })

  for (const decision of SenderDecision.shape.decision.options) {
    senders
      .command(decision)
      .argument('<address>')
      .requiredOption('--account <id>', 'exact Account ID')
      .option('--revision <n>', 'expected Sender rule revision')
      .option('--reason-file <path>', 'read the private reason from a file or - for stdin')
      .option('--action-id <id>', 'reuse this action UUID on retry')
      .action(async (address: string, { account, revision, actionId, reasonFile }) => {
        const api = authed(config())
        if (revision !== undefined && !/^\d+$/.test(revision))
          throw new Error('Expected a nonnegative Sender rule revision')
        if (actionId && revision === undefined)
          throw new Error('--action-id requires the original --revision for an exact retry')
        const body = SenderDecision.parse({
          accountId: account,
          address,
          decision,
          expectedRevision:
            revision === undefined ? await senderRevision(api, account, address) : Number(revision),
          clientActionId: actionId ?? randomUUID(),
          reason: reasonFile ? await readPrivateReason(reasonFile) : undefined,
        })
        const result = await api<OwnerActionStatus>('/v1/senders/decisions', {
          method: 'POST',
          body,
        })
        printOwnerAction(result)
      })
  }

  for (const command of ['status', 'undo'] as const) {
    senders
      .command(command)
      .argument('<action-id>', 'exact owner action ID')
      .action(async (id: string) => {
        const path = `/v1/owner-actions/${encodeURIComponent(id)}`
        const result = await authed(config())<OwnerActionStatus>(
          command === 'undo' ? `${path}/undo` : path,
          { method: command === 'undo' ? 'POST' : 'GET' },
        )
        printOwnerAction(result, command === 'undo')
      })
  }

  senders
    .command('avatar')
    .argument('<message-id>', 'exact message ID')
    .option('--out <file>', 'write the cached PNG to a new file')
    .action(async (messageId: string, { out }) => {
      const pairing = config()
      const at = messageId.indexOf(':')
      if (at < 1) throw new Error('Expected an Account-qualified message ID')
      const accountId = messageId.slice(0, at)
      const { rows } = await authed(pairing)<SenderAvatarResults>('/v1/sender-avatars/resolve', {
        method: 'POST',
        body: { messages: [{ accountId, messageId }] },
      })
      const avatar = rows.find((row) => row.accountId === accountId && row.messageId === messageId)
      if (!avatar) throw new Error('Sender avatar metadata is unavailable')
      console.log(JSON.stringify(avatar, null, 2))
      if (out) {
        if (!avatar.digest) throw new Error('No cached PNG is available for this message')
        await saveAvatar(pairing, avatar.digest, out)
      }
    })
  return senders
}

async function saveAvatar(config: CliConfig, digest: string, out: string) {
  if (!/^[0-9a-f]{64}$/.test(digest)) throw new Error('Invalid cached PNG digest')
  const path = `/v1/sender-avatars/${digest}`
  const image = await response(config.engineUrl, path, {
    token: config.token,
    redirect: 'error',
    signal: AbortSignal.timeout(10_000),
  })
  if (image.headers.get('content-type') !== 'image/png' || !image.body)
    throw new Error('Engine did not return a cached PNG')
  const chunks: Uint8Array[] = []
  const reader = image.body.getReader()
  let size = 0
  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > 32 * 1024) {
      await reader.cancel()
      throw new Error('Cached PNG exceeds the size limit')
    }
    chunks.push(value)
  }
  const png = Buffer.concat(chunks)
  if (!png.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')))
    throw new Error('Invalid cached PNG')
  await writeFile(out, png, { flag: 'wx' })
}
