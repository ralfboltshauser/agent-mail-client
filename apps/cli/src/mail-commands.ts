import type { AgentAction, Label, ThreadSummary } from '@amc/protocol'
import type { Command } from 'commander'
import type { CliConfig } from './config.ts'
import { mailTool } from './mcp.ts'

type AgentOrganizeTool =
  | 'archive'
  | 'mark_read'
  | 'mark_unread'
  | 'star'
  | 'unstar'
  | 'mute'
  | 'add_label'
  | 'remove_label'

export function addThread(id: string, previous: string[] = []) {
  return [...previous, id]
}

const printJson = (value: unknown) => console.log(JSON.stringify(value, null, 2))

function printAction(action: AgentAction, json?: boolean) {
  if (json) printJson(action)
  else {
    console.log(`${action.status} · agent action ${action.id}`)
    if (action.status === 'pending')
      console.log(`Check with amc --as-agent agent status ${action.id}`)
    if (action.error) console.error(action.error)
  }
  if (['failed', 'partial', 'rejected'].includes(action.status)) process.exitCode = 1
}

export async function agentOrganize(
  config: CliConfig,
  tool: AgentOrganizeTool,
  threads: string[],
  json?: boolean,
  labelId?: string,
) {
  const ids = [...new Set(threads)]
  if (ids.length > 20) throw new Error('Pass at most 20 distinct threads per batch.')
  const result = await mailTool<AgentAction>(
    config,
    true,
    tool,
    { thread_ids: ids, label_id: labelId },
    { write: true },
  )
  printAction(result, json)
}

export function registerMailCommands(
  program: Command,
  triage: Command,
  senders: Command,
  agentCommands: Command,
  config: () => CliConfig,
  agent: () => boolean,
  printThreads: (threads: ThreadSummary[]) => void,
) {
  program
    .command('whoami')
    .description('Show the current mail grant')
    .option('--json', 'print JSON')
    .action(async (opts: { json?: boolean }) => {
      const me = await mailTool<{ name: string; scopes: string[]; accountId: string | null }>(
        config(),
        agent(),
        'whoami',
      )
      if (opts.json) return printJson(me)
      console.log(`${me.name} · ${me.scopes.join(', ')}${me.accountId ? ` · ${me.accountId}` : ''}`)
    })

  program
    .command('message')
    .description('Read one message')
    .argument('<message-id>')
    .option('--json', 'print JSON')
    .action(async (id: string, opts: { json?: boolean }) => {
      const message = await mailTool<{ bodyText: string }>(config(), agent(), 'get_message', {
        messageId: id,
      })
      if (opts.json) return printJson(message)
      console.log(message.bodyText)
    })

  program
    .command('labels')
    .description('List mail labels')
    .option('--account <id>', 'Account ID')
    .option('--json', 'print JSON')
    .action(async (opts: { account?: string; json?: boolean }) => {
      const labels = await mailTool<Label[]>(config(), agent(), 'list_labels', {
        account_id: opts.account,
      })
      if (opts.json) return printJson(labels)
      for (const label of labels) console.log(`${label.id}\t${label.name}`)
    })

  triage
    .command('untriaged')
    .description('List Inbox threads without a bucket')
    .option('-n, --limit <n>', 'page size')
    .option('--json', 'print JSON')
    .action(async (_opts, command: Command) => {
      const { account, recent, limit, json } = command.optsWithGlobals()
      const threads = await mailTool<ThreadSummary[]>(config(), agent(), 'list_untriaged', {
        account_id: account,
        recent,
        limit: limit === undefined ? undefined : Number(limit),
      })
      if (json) return printJson(threads)
      printThreads(threads)
    })

  senders
    .command('suggest')
    .description('Suggest a sender decision for owner review (agent only)')
    .argument('<message-id>')
    .requiredOption('--decision <decision>', 'accept or block')
    .requiredOption('--reason <text>', 'one-line reason')
    .option('--json', 'print JSON')
    .action(async (id: string, opts: { decision: string; reason: string; json?: boolean }) => {
      if (!agent()) throw new Error('Sender suggestions require --as-agent.')
      const result = await mailTool<unknown>(
        config(),
        true,
        'suggest_sender_rule',
        {
          message_id: id,
          decision: opts.decision,
          reason: opts.reason,
        },
        { write: true },
      )
      if (opts.json) return printJson(result)
      console.log('Submitted sender suggestion for owner review.')
    })

  agentCommands
    .command('status')
    .description('Check an organize action from this agent grant')
    .argument('<action-id>')
    .option('--json', 'print JSON')
    .action(async (id: string, opts: { json?: boolean }) => {
      if (!agent()) throw new Error('Agent action status requires --as-agent.')
      const result = await mailTool<AgentAction>(config(), true, 'organize_status', {
        action_id: id,
      })
      printAction(result, opts.json)
    })
}
