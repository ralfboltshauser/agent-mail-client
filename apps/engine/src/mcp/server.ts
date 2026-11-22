import {
  BucketInput,
  hasScope,
  type OrganiseAction,
  type Scope,
  SubmitTriagePrediction,
  TRIAGE_RECENT_WINDOW_MS,
  TriageBucketResult,
  UntriagedLimit,
} from '@amc/protocol'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { handoffGrant } from '../auth/handoff.ts'
import { type Principal, withinAccount } from '../auth/tokens.ts'
import { type Db, transaction } from '../db/database.ts'
import {
  agentAction,
  agentCreatedDraft,
  draftAsAgent,
  organizeAsAgent,
  setBucketAsAgent,
  threadAccount,
} from '../mail/agent-actions.ts'
import { DraftError, DraftRevisionConflict, type Drafts, searchContacts } from '../mail/drafts.ts'
import type { Mutations } from '../mail/mutations.ts'
import type { MailQueries } from '../mail/queries.ts'
import { suggestSenderRule } from '../mail/senders/suggestions.ts'
import type { MailStore } from '../mail/store.ts'
import { threadInput } from '../mail/triage/input.ts'
import {
  hasTriageLease,
  prepareContext,
  setLegacyUntriagedBucket,
  setModelBucket,
  submitPrediction,
} from '../mail/triage/model.ts'
import { VERSION } from '../version.ts'

export interface McpDeps {
  db: Db
  store: MailStore
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
const MAX_THREAD_TEXT = 100_000

function json(value: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(value, null, 1) }] }
}

function draftFailure(error: DraftError, read: boolean) {
  if (!(error instanceof DraftRevisionConflict)) return failure(error.message)
  return {
    ...json({
      error: 'conflict',
      message: error.message,
      revision: error.revision,
      ...(read ? { body: error.body } : {}),
    }),
    isError: true,
  }
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
  const handoff = principal.kind === 'agent' && Boolean(principal.threadId)
  const server = new McpServer(
    { name: 'amc', version: VERSION },
    {
      instructions: handoff
        ? 'Read the assigned Thread and update the draft body using its current revision.'
        : "AMC is the owner's mail. You can read Threads, search the entire history, look up contacts, " +
          'and write drafts that appear in Gmail for the owner to review. You cannot send mail. ' +
          'To reply, call create_draft with the thread_id; recipients, subject and threading are filled in.',
    },
  )
  const can = (scope: Scope) => hasScope(principal.scopes, scope)
  const { queries, drafts, db, mutations } = deps
  const agent = principal.kind === 'agent' ? principal : undefined
  const accountId = agent?.accountId
  const draftOptions = accountId ? { accountId } : {}

  if (principal.kind === 'composer') return server
  if (handoff) {
    registerHandoffTools(server, principal, deps)
    return server
  }

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

  if (agent && can('read')) {
    server.registerTool(
      'suggest_sender_rule',
      {
        description:
          'Suggest an Accept or Block decision for the Sender of a message. The owner reviews the suggestion.',
        inputSchema: {
          message_id: z.string().min(1).max(512),
          decision: z.enum(['accept', 'block']),
          reason: z.string().trim().min(1).max(240),
        },
      },
      ({ message_id, decision, reason }) => {
        const result = suggestSenderRule(db, agent, message_id, decision, reason)
        return 'error' in result ? failure(result.error) : json(result)
      },
    )
  }

  if (agent && can('organize')) {
    server.registerTool(
      'set_bucket',
      {
        description: 'Set an AMC Bucket and one-line reason. Set bucket to null to clear.',
        inputSchema: BucketInput.extend({
          triage: TriageBucketResult.optional(),
          onlyUntriaged: z
            .boolean()
            .optional()
            .describe('Skip if the Thread left the Inbox or already has a Bucket.'),
        }),
        annotations: { destructiveHint: false },
      },
      async ({ onlyUntriaged, triage, ...input }) => {
        if (!triage) {
          const result = onlyUntriaged
            ? setLegacyUntriagedBucket(deps.store, agent, input)
            : setBucketAsAgent(deps.store, agent, input)
          return 'error' in result && typeof result.error === 'string'
            ? failure(result.error)
            : json({ updated: result.updated })
        }
        const result = setModelBucket(deps.store, agent, input, triage)
        return 'error' in result && typeof result.error === 'string'
          ? failure(result.error)
          : json({
              updated: result.updated,
              ...('reason' in result && result.reason ? { reason: result.reason } : {}),
            })
      },
    )
  }

  if (agent && can('organize') && hasTriageLease(db, agent, 'organize')) {
    server.registerTool(
      'submit_triage_prediction',
      {
        description:
          'Submit independent Bucket and Filter assessments for one captured triage input.',
        inputSchema: SubmitTriagePrediction,
      },
      async (request) => {
        const result = submitPrediction(deps.store, agent, request)
        return 'error' in result && result.error ? failure(result.error) : json(result)
      },
    )
  }

  if (can('read')) {
    server.registerTool(
      'list_untriaged',
      {
        description: 'List Inbox Threads without a Bucket, newest first.',
        inputSchema: {
          limit: UntriagedLimit,
          reviewContext: z.boolean().optional(),
          decisionLogVersion: z.number().int().optional(),
          account_id: z.string().optional(),
          recent: z
            .boolean()
            .optional()
            .describe('Require provider delivery in the last 24 hours.'),
        },
        annotations: { readOnlyHint: true },
      },
      async ({ limit, account_id, recent, reviewContext, decisionLogVersion }) => {
        const target = account_id ?? accountId
        if (!withinAccount(principal, target)) return failure('Account unavailable to this Agent')
        const list = () =>
          queries.threads({
            inbox: true,
            untriaged: true,
            accountId: target,
            limit,
            ...(reviewContext ? { triageInput: true } : {}),
            ...(recent ? { deliveredSince: Date.now() - TRIAGE_RECENT_WINDOW_MS } : {}),
          }).threads
        if (!reviewContext) return json(list())
        if (!target || !agent || !hasTriageLease(db, agent, 'read'))
          return failure('A live Account-scoped triage lease is required')
        return json(
          transaction(db, () => {
            const threads = list()
            if (decisionLogVersion === 1) {
              const context = prepareContext(db, agent, target, threads)
              const available = new Set(context.refs.map(({ threadId }) => threadId))
              return { threads: threads.filter(({ id }) => available.has(id)), ...context }
            }
            return {
              threads: threads.map((thread) => ({
                ...thread,
                inputRevision: threadInput(db, thread.id)?.modseq,
              })),
              examples: [],
            }
          }),
        )
      },
    )

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
          'Read a Thread with every message, including sender, recipients, date, plain-text body and attachments. Text is capped at 20,000 characters per message and 100,000 per Thread, prioritizing newer messages. Use get_message when […truncated] marks omitted text.',
        inputSchema: { thread_id: z.string() },
        annotations: { readOnlyHint: true },
      },
      async ({ thread_id }) => {
        const thread = withinAccount(principal, threadAccount(db, thread_id))
          ? queries.agentThread(thread_id, MAX_BODY, MAX_THREAD_TEXT)
          : null
        if (!thread) return failure(`No Thread ${thread_id}`)
        return json({
          ...thread,
          drafts: drafts.list({ ...draftOptions, threadId: thread_id }),
        })
      },
    )

    server.registerTool(
      'get_message',
      {
        description: 'Read one message. Text beyond 20,000 characters is marked with […truncated].',
        inputSchema: { messageId: z.string() },
        annotations: { readOnlyHint: true },
      },
      async ({ messageId }) => {
        const message = queries.agentMessage(messageId, MAX_BODY)
        return message && withinAccount(principal, message.accountId)
          ? json(message)
          : failure(`No message ${messageId}`)
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
        if (!draft || !withinAccount(principal, draft.accountId))
          return failure(`No draft ${draft_id}`)
        return json(draft)
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
          ...(agent
            ? {
                revision: z
                  .number()
                  .int()
                  .nonnegative()
                  .optional()
                  .describe('Required for body edits. Use the revision returned by AMC.'),
              }
            : {}),
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
            if (agent && a.body !== undefined && a.revision === undefined)
              throw new DraftError('Pass the revision returned by AMC when editing a draft body')
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
              agent ? a.revision : undefined,
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
          if (error instanceof DraftError) return draftFailure(error, can('read'))
          throw error
        }
      },
    )

    if (!agent)
      server.registerTool(
        'delete_draft',
        {
          description:
            'Discard a draft and remove the provider copy if it still matches what AMC last wrote.',
          inputSchema: { draft_id: z.string() },
          annotations: { destructiveHint: true },
        },
        async ({ draft_id }) => json(await drafts.delete(draft_id)),
      )
  }

  return server
}

function registerHandoffTools(
  server: McpServer,
  principal: Principal,
  { db, queries, drafts }: McpDeps,
) {
  if (hasScope(principal.scopes, 'read')) {
    server.registerTool(
      'get_thread',
      {
        description: 'Read the Thread selected for this handoff.',
        inputSchema: { thread_id: z.string() },
      },
      ({ thread_id }) => {
        if (handoffGrant(db, principal)?.thread_id !== thread_id)
          return failure('Thread outside this handoff')
        const thread = queries.agentThread(thread_id, MAX_BODY, MAX_THREAD_TEXT, true)
        return thread ? json(thread) : failure('Thread unavailable')
      },
    )
    server.registerTool(
      'read_draft',
      {
        description: 'Read this handoff draft and its current revision.',
        inputSchema: { draft_id: z.string() },
      },
      ({ draft_id }) => {
        if (handoffGrant(db, principal)?.draft_id !== draft_id)
          return failure('Draft outside this handoff')
        const draft = drafts.openCompose(draft_id)
        return draft
          ? json({ body: draft.body, revision: draft.revision })
          : failure('Draft unavailable')
      },
    )
  }
  if (!hasScope(principal.scopes, 'draft')) return
  server.registerTool(
    'update_draft',
    {
      description: 'Replace this draft body as plain text using the revision from read_draft.',
      inputSchema: {
        draft_id: z.string(),
        body: z.string().max(MAX_BODY),
        revision: z.number().int().nonnegative(),
      },
    },
    async ({ draft_id, body, revision }) => {
      const grant = handoffGrant(db, principal)
      try {
        const draft = await draftAsAgent(
          db,
          principal,
          'update_draft',
          grant?.thread_id ?? null,
          () => {
            if (grant?.draft_id !== draft_id) throw new DraftError('Draft outside this handoff')
            return drafts.replaceComposeBody(draft_id, body, revision, principal.name)
          },
        )
        return json({ body: 'body' in draft ? draft.body : undefined, revision: draft.revision })
      } catch (error) {
        if (error instanceof DraftError)
          return draftFailure(error, hasScope(principal.scopes, 'read'))
        throw error
      }
    },
  )
}
