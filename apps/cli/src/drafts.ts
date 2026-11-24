import { readFile } from 'node:fs/promises'
import { text } from 'node:stream/consumers'
import { type Address, type DiscardDraftResult, mailLink, type VersionedDraft } from '@amc/protocol'
import type { Command } from 'commander'
import { z } from 'zod'
import type { CliConfig } from './config.ts'
import { mailTool } from './mcp.ts'

type DraftOptions = {
  to?: (Address | null)[]
  cc?: (Address | null)[]
  bcc?: (Address | null)[]
  subject?: string
  bodyFile?: string
  json?: boolean
}

const DraftId = z.string().min(1)
const DraftReceipt = z.looseObject({
  id: DraftId,
  revision: z.number().int().nonnegative(),
  mirrorStatus: z.string().optional(),
})
type DraftReceipt = z.infer<typeof DraftReceipt>

const DiscardReceipt = z.union([
  z.object({ absent: DraftId }),
  z.object({
    deleted: DraftId,
    providerRemoved: z.enum(['Gmail', 'IMAP']).optional(),
    warning: z.string().optional(),
  }),
])

function addAddress(value: string, previous: (Address | null)[] = []) {
  if (value === '') return [...previous, null]
  const match = /^(.*?)\s*<([^<>]+)>$/.exec(value.trim())
  const address = (match?.[2] ?? value).trim()
  if (!z.email().safeParse(address).success)
    throw new Error('Pass one email address or "Name <address>" per recipient option.')
  return [...previous, { address, name: match?.[1]?.trim() || null }]
}

function draftFields(command: Command) {
  return command
    .option('--to <address>', 'recipient, repeatable', addAddress)
    .option('--cc <address>', 'copy recipient, repeatable', addAddress)
    .option('--bcc <address>', 'blind copy recipient, repeatable', addAddress)
    .option('--subject <text>', 'subject')
    .option('--body-file <path>', 'plain text file or - for stdin')
    .option('--json', 'print JSON')
}

async function fields(opts: DraftOptions) {
  const patch: Record<string, unknown> = {}
  for (const key of ['to', 'cc', 'bcc'] as const) {
    const addresses = opts[key]
    if (addresses?.length) {
      if (addresses.includes(null) && addresses.length !== 1)
        throw new Error('Use an empty recipient option by itself to clear that field.')
      patch[key] = addresses.filter((address) => address !== null)
    }
  }
  if (opts.subject !== undefined) patch.subject = opts.subject
  if (opts.bodyFile !== undefined)
    patch.body =
      opts.bodyFile === '-' ? await text(process.stdin) : await readFile(opts.bodyFile, 'utf8')
  return patch
}

function revision(value: string) {
  const number = Number(value)
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(number))
    throw new Error('Pass a revision from AMC.')
  return number
}

const printJson = (value: unknown) => console.log(JSON.stringify(value, null, 2))

function printReceipt(result: DraftReceipt, engineUrl: string, json?: boolean) {
  const draftLink = mailLink(engineUrl, { kind: 'draft', draftId: result.id })
  if (json) return printJson({ ...result, draftLink })
  const mirror = result.mirrorStatus ?? 'unknown'
  console.log(`Saved draft ${result.id} · revision ${result.revision} · provider mirror ${mirror}`)
  console.log(draftLink)
}

export function registerDraftCommands(
  program: Command,
  config: () => CliConfig,
  agent: () => boolean,
) {
  const draft = program.command('draft').description('Save and edit drafts for review')
  const create = draftFields(
    draft.command('create').description('Save a new email as a draft'),
  ).option('--account <id>', 'sending Account ID, defaults to the grant’s Account')
  create.action(async (opts: DraftOptions & { account?: string }) => {
    if (opts.bodyFile === undefined) throw new Error('Pass --body-file <path> or --body-file -.')
    const cli = config()
    const result = await mailTool<DraftReceipt>(
      cli,
      agent(),
      'create_draft',
      { account_id: opts.account, ...(await fields(opts)), report_mirror: true },
      { write: true, result: DraftReceipt },
    )
    printReceipt(result, cli.engineUrl, opts.json)
  })

  draftFields(program.command('reply').description('Save a threaded reply as a draft'))
    .argument('<thread-id>')
    .option('--reply-all', 'include other recipients')
    .action(async (threadId: string, opts: DraftOptions & { replyAll?: boolean }) => {
      if (opts.bodyFile === undefined) throw new Error('Pass --body-file <path> or --body-file -.')
      const cli = config()
      const result = await mailTool<DraftReceipt>(
        cli,
        agent(),
        'create_draft',
        {
          thread_id: threadId,
          ...(await fields(opts)),
          reply_all: opts.replyAll,
          report_mirror: true,
        },
        { write: true, result: DraftReceipt },
      )
      printReceipt(result, cli.engineUrl, opts.json)
    })

  draft
    .command('list')
    .option('--thread <id>', 'only drafts for this Thread')
    .option('--json', 'print JSON')
    .action(async (opts: { thread?: string; json?: boolean }) => {
      const drafts = await mailTool<VersionedDraft[]>(config(), agent(), 'list_drafts', {
        thread_id: opts.thread,
      })
      if (opts.json) return printJson(drafts)
      if (!drafts.length) console.log('No drafts.')
      for (const item of drafts)
        console.log(`${item.id} · revision ${item.revision} · ${item.subject}`)
    })

  draft
    .command('show')
    .argument('<draft-id>')
    .option('--json', 'print JSON')
    .action(async (id: string, opts: { json?: boolean }) => {
      const result = await mailTool<VersionedDraft>(config(), agent(), 'read_draft', {
        draft_id: id,
      })
      if (opts.json) return printJson(result)
      console.log(`${id} · revision ${result.revision}`)
      if (result.subject !== undefined) console.log(result.subject)
      console.log(result.body)
    })

  draftFields(draft.command('update').description('Change the specified draft fields'))
    .argument('<draft-id>')
    .requiredOption('--revision <n>', 'revision from draft show or the last write')
    .action(async (id: string, opts: DraftOptions & { revision: string }) => {
      const current = revision(opts.revision)
      const patch = await fields(opts)
      if (!Object.keys(patch).length) throw new Error('Choose draft fields to update.')
      const cli = config()
      const result = await mailTool<DraftReceipt>(
        cli,
        agent(),
        'update_draft',
        { draft_id: id, ...patch, revision: current, report_mirror: true },
        { checked: true, write: true, result: DraftReceipt.refine((receipt) => receipt.id === id) },
      )
      printReceipt(result, cli.engineUrl, opts.json)
    })

  draft
    .command('discard')
    .argument('<draft-id>')
    .description('Discard a reviewed draft (paired owner only)')
    .requiredOption('--revision <n>', 'revision from draft show')
    .option('--json', 'print JSON')
    .action(async (id: string, opts: { revision: string; json?: boolean }) => {
      if (agent()) throw new Error('Draft discard requires the paired owner.')
      const result = await mailTool<DiscardDraftResult>(
        config(),
        false,
        'delete_draft',
        { draft_id: id, revision: revision(opts.revision) },
        {
          checked: true,
          write: true,
          result: DiscardReceipt.refine(
            (receipt) => ('deleted' in receipt ? receipt.deleted : receipt.absent) === id,
          ),
        },
      )
      if (opts.json) return printJson(result)
      console.log(
        'deleted' in result
          ? `Discarded draft ${result.deleted}`
          : `Draft ${id} is already absent.`,
      )
      if ('warning' in result && result.warning) console.warn(result.warning)
    })
}
