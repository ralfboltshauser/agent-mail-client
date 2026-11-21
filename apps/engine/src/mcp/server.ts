import { hasScope, type OrganiseAction, type Scope } from '@amc/protocol'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { type Principal, withinAccount } from '../auth/tokens.ts'
import type { Db } from '../db/database.ts'
import {
  agentAction,
  agentCreatedDraft,
  draftAsAgent,
  organizeAsAgent,
  threadAccount,
} from '../mail/agent-actions.ts'
import { DraftError, type Drafts, searchContacts } from '../mail/drafts.ts'
import type { Mutations } from '../mail/mutations.ts'
import type { MailQueries } from '../mail/queries.ts'
import { VERSION } from '../version.ts'

export interface McpDeps {
  db: Db
  queries: MailQueries
  drafts: Drafts
  mutations?: Mutations | undefined
}

const AddressInput = z.object({
  name: z.string().nullable().optional().describe('Display name'),
  address: z.string().describe('Email address'),
})
const toAddresses = (list: z.infer<typeof AddressInput>[] | undefined) =>
  list?.map((a) => ({ name: a.name ?? null, address: a.address }))

const MAX_BODY = 20_000

function json(value: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(value, null, 1) }] }
}

function failure(message: string) {
  return { content: [{ type: 'text' as const, text: message }], isError: true }
}

/**
 * The MCP surface for one Agent token. Tools are registered only for the scopes the token
 * holds, so a missing scope means the tool does not exist (ADR 0001). There is no send tool
 * here at all; sending stays with the owner.
 */
export function buildMcpServer(principal: Principal, deps: McpDeps): McpServer {
  const server = new McpServer(
    { name: 'amc', version: VERSION },
    {
      instructions:
        "AMC is the owner's mail. You can read Threads, search the entire history, look up contacts, " +
        'and write drafts that appear in Gmail for the owner to review. You cannot send mail. ' +
        'To reply, call create_draft with the thread_id; recipients, subject and threading are filled in.',
    },
  )
  const can = (scope: Scope) => hasScope(principal.scopes, scope)
  const { queries, drafts, db, mutations } = deps
  const agent = principal.kind === 'agent' ? principal : undefined
  const accountId = agent?.accountId
  const draftOptions = accountId ? { accountId } : {}

  server.registerTool(
    'whoami',
    {
      description: 'Which AMC token this is and what it may do. Sending mail is not among them.',
      annotations: { readOnlyHint: true },
    },
    async () =>
      json({
        name: principal.name,
        scopes: principal.scopes.filter(
          (scope) => !agent || (scope !== 'admin' && scope !== 'send'),
        ),
        accountId: accountId ?? null,
      }),
  )

  if (can('read')) {
    server.registerTool(
      'list_accounts',
      {
        description: 'List the mail Accounts and their sync state.',
        annotations: { readOnlyHint: true },
      },
      async () =>
        json(
          (accountId ? [queries.account(accountId)] : queries.accounts()).flatMap((account) =>
            account ? [{ id: account.id, address: account.address, status: account.status }] : [],
          ),
        ),
    )

    server.registerTool(
      'list_threads',
      {
        description: 'List Threads, newest first. Defaults to the Inbox across all Accounts.',
        inputSchema: {
          view: z.enum(['inbox', 'all']).default('inbox').describe('inbox or all mail'),
          label_id: z
            .string()
            .optional()
            .describe('Only Threads with this Label id (see list_labels)'),
          unread: z.boolean().optional(),
          account_id: z.string().optional(),
          limit: z.number().int().min(1).max(100).default(25),
          before: z
            .number()
            .optional()
            .describe('Paging: the nextBefore value from the previous call'),
        },
        annotations: { readOnlyHint: true },
      },
      async (a) =>
        json(
          queries.threads({
            inbox: a.view === 'inbox' && !a.label_id,
            ...(a.label_id ? { labelId: a.label_id } : {}),
            ...(a.unread !== undefined ? { unread: a.unread } : {}),
            ...((accountId ?? a.account_id) ? { accountId: accountId ?? a.account_id } : {}),
            ...(a.before !== undefined ? { before: a.before } : {}),
            limit: a.limit,
          }),
        ),
    )

    server.registerTool(
      'get_thread',
      {
        description:
          'Read a whole Thread: every message with sender, recipients, date, plain-text body and attachments.',
        inputSchema: { thread_id: z.string() },
        annotations: { readOnlyHint: true },
      },
      async ({ thread_id }) => {
        const thread = withinAccount(principal, threadAccount(db, thread_id))
          ? queries.thread(thread_id)
          : null
        if (!thread) return failure(`No Thread ${thread_id}`)
        return json({
          ...thread,
          messages: thread.messages.map((m) => ({
            ...m,
            bodyText:
              m.bodyText.length > MAX_BODY
                ? `${m.bodyText.slice(0, MAX_BODY)}\n[…truncated]`
                : m.bodyText,
          })),
          drafts: drafts.list({ ...draftOptions, threadId: thread_id }),
        })
      },
    )

    server.registerTool(
      'search',
      {
        description:
          'Full-text search over the entire mail history. All words must match; from:, to: and subject: narrow it. Returns Threads.',
        inputSchema: {
          query: z.string().min(1),
          account_id: z.string().optional(),
          limit: z.number().int().min(1).max(50).default(15),
        },
        annotations: { readOnlyHint: true },
      },
      async (a) =>
        json(
          queries.search(a.query, {
            ...((accountId ?? a.account_id) ? { accountId: accountId ?? a.account_id } : {}),
            limit: a.limit,
          }),
        ),
    )

    if (!accountId)
      server.registerTool(
        'search_contacts',
        {
          description:
            'Find people the owner has mailed with, by name or address. Most frequent first.',
          inputSchema: {
            query: z.string().min(1),
            limit: z.number().int().min(1).max(25).default(10),
          },
          annotations: { readOnlyHint: true },
        },
        async (a) => json(searchContacts(db, a.query, a.limit)),
      )

    server.registerTool(
      'list_labels',
      {
        description: 'List Labels (Gmail labels and system folders such as INBOX, SENT).',
        inputSchema: { account_id: z.string().optional() },
        annotations: { readOnlyHint: true },
      },
      async (a) => json(queries.labels(accountId ?? a.account_id)),
    )

    server.registerTool(
      'list_drafts',
      {
        description: 'List AMC drafts, newest first, optionally for one Thread.',
        inputSchema: { thread_id: z.string().max(512).optional() },
        annotations: { readOnlyHint: true },
      },
      async (a) =>
        json(drafts.list({ ...draftOptions, ...(a.thread_id ? { threadId: a.thread_id } : {}) })),
    )

    server.registerTool(
      'read_draft',
      {
        description: 'Read one draft, including any edits the owner made by hand.',
        inputSchema: { draft_id: z.string() },
        annotations: { readOnlyHint: true },
      },
      async ({ draft_id }) => {
        const draft = drafts.get(draft_id)
        return draft && withinAccount(principal, draft.accountId)
          ? json(draft)
          : failure(`No draft ${draft_id}`)
      },
    )
  }

  if (agent && mutations && can('organize')) {
    type Action = Exclude<OrganiseAction, { kind: 'trash' | 'snooze' | 'undo' }>
    const tools: [string, string, (threadId: string, labelId: string) => Action][] = [
      ['archive', 'Archive', (threadId) => ({ kind: 'archive', threadId })],
      ['mark_read', 'Mark as read', (threadId) => ({ kind: 'read', threadId, value: true })],
      ['mark_unread', 'Mark as unread', (threadId) => ({ kind: 'read', threadId, value: false })],
      ['star', 'Star', (threadId) => ({ kind: 'star', threadId, value: true })],
      ['unstar', 'Unstar', (threadId) => ({ kind: 'star', threadId, value: false })],
      [
        'add_label',
        'Add a user Label to',
        (threadId, labelId) => ({ kind: 'label', threadId, labelId, value: true }),
      ],
      [
        'remove_label',
        'Remove a user Label from',
        (threadId, labelId) => ({ kind: 'label', threadId, labelId, value: false }),
      ],
      ['mute', 'Mute', (threadId) => ({ kind: 'mute', threadId, value: true })],
    ]
    for (const [tool, verb, action] of tools) {
      server.registerTool(
        tool,
        {
          description: `${verb} the given Gmail Threads. Returns per-message status. Use organize_status to check pending writeback.`,
          inputSchema: {
            thread_ids: z.array(z.string().min(1).max(512)).min(1).max(20),
            ...(tool.endsWith('_label') ? { label_id: z.string().min(1).max(512) } : {}),
          },
        },
        async ({ thread_ids, label_id }) => {
          const entry = organizeAsAgent(
            db,
            mutations,
            agent,
            tool,
            [...new Set(thread_ids)].map((id) => action(id, label_id ?? '')),
          )
          if (entry.error) return failure(entry.error)
          mutations.kick()
          return json(agentAction(db, mutations, agent.tokenId, entry.id))
        },
      )
    }
    server.registerTool(
      'organize_status',
      {
        description: 'Check the writeback result of one of this token’s organize actions.',
        inputSchema: { action_id: z.uuid() },
        annotations: { readOnlyHint: true },
      },
      async ({ action_id }) => {
        const action = agentAction(db, mutations, agent.tokenId, action_id)
        return action ? json(action) : failure('No action for this token')
      },
    )
  }

  if (can('draft')) {
    server.registerTool(
      'create_draft',
      {
        description:
          'Write a draft. With thread_id it is a reply: recipients, "Re:" subject and threading headers are filled in ' +
          '(override any of them). It appears in Gmail as a draft for the owner to review and send. It is never sent.',
        inputSchema: {
          thread_id: z.string().max(512).optional(),
          account_id: z
            .string()
            .optional()
            .describe('Required for a new message without thread_id'),
          to: z.array(AddressInput).optional(),
          cc: z.array(AddressInput).optional(),
          bcc: z.array(AddressInput).optional(),
          subject: z.string().optional(),
          body: z.string().describe('Plain-text body'),
          reply_all: z.boolean().optional(),
        },
        annotations: { destructiveHint: false },
      },
      async (a) => {
        try {
          const write = () => {
            const target = a.thread_id
              ? threadAccount(db, a.thread_id)
              : (a.account_id ?? accountId)
            if (!withinAccount(principal, target))
              throw new DraftError('Account unavailable to this Agent')
            return drafts.create(
              {
                ...(a.thread_id ? { threadId: a.thread_id } : {}),
                ...(target ? { accountId: target } : {}),
                ...(a.to ? { to: toAddresses(a.to) } : {}),
                ...(a.cc ? { cc: toAddresses(a.cc) } : {}),
                ...(a.bcc ? { bcc: toAddresses(a.bcc) } : {}),
                ...(a.subject !== undefined ? { subject: a.subject } : {}),
                body: a.body,
                ...(a.reply_all !== undefined ? { replyAll: a.reply_all } : {}),
              },
              principal.name,
            )
          }
          return json(
            agent
              ? await draftAsAgent(db, agent, 'create_draft', a.thread_id ?? null, write)
              : await write(),
          )
        } catch (error) {
          if (error instanceof DraftError) return failure(error.message)
          throw error
        }
      },
    )

    server.registerTool(
      'update_draft',
      {
        description: can('read')
          ? 'Change a draft. Only the fields you pass change. Read it first: the owner may have edited it.'
          : 'Change a draft created by this grant. Only the fields you pass change.',
        inputSchema: {
          draft_id: z.string(),
          to: z.array(AddressInput).optional(),
          cc: z.array(AddressInput).optional(),
          bcc: z.array(AddressInput).optional(),
          subject: z.string().optional(),
          body: z.string().optional(),
        },
        annotations: { destructiveHint: false },
      },
      async (a) => {
        try {
          const draft = db
            .prepare('SELECT account_id, thread_id FROM draft WHERE id = ?')
            .get(a.draft_id) as { account_id: string; thread_id: string | null } | undefined
          const allowed =
            !agent ||
            (draft &&
              withinAccount(agent, draft.account_id) &&
              (can('read') || agentCreatedDraft(db, agent, a.draft_id)))
          const write = () => {
            if (!allowed) throw new DraftError('Draft unavailable to this Agent')
            return drafts.update(
              a.draft_id,
              {
                ...(a.to ? { to: toAddresses(a.to) } : {}),
                ...(a.cc ? { cc: toAddresses(a.cc) } : {}),
                ...(a.bcc ? { bcc: toAddresses(a.bcc) } : {}),
                ...(a.subject !== undefined ? { subject: a.subject } : {}),
                ...(a.body !== undefined ? { body: a.body } : {}),
              },
              principal.name,
            )
          }
          return json(
            agent
              ? await draftAsAgent(
                  db,
                  agent,
                  'update_draft',
                  allowed ? (draft?.thread_id ?? null) : null,
                  write,
                )
              : await write(),
          )
        } catch (error) {
          if (error instanceof DraftError) return failure(error.message)
          throw error
        }
      },
    )

    if (!agent)
      server.registerTool(
        'delete_draft',
        {
          description: 'Discard a draft (also removes it from Gmail).',
          inputSchema: { draft_id: z.string() },
          annotations: { destructiveHint: true },
        },
        async ({ draft_id }) => {
          await drafts.delete(draft_id)
          return json({ deleted: draft_id })
        },
      )
  }

  return server
}
