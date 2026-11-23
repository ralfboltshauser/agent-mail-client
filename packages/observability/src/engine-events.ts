const methods = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS', 'OTHER'] as const
export type HttpMethod = (typeof methods)[number]
export const httpMethod = (method: string): HttpMethod =>
  methods.find((entry) => entry === method) ?? 'OTHER'

const outcome = { durationMs: 'duration', count: 'count', recovered: 'boolean' } as const
const failure = { durationMs: 'duration', count: 'count', err: 'error' } as const
const syncPhases = ['startup', 'history', 'backfill', 'all', 'inbox'] as const
const pubSubOperations = ['pull', 'acknowledge'] as const
const outboxStages = ['submit', 'reconcile', 'worker'] as const
const transports = ['sse', 'websocket'] as const

export const engineEvents = {
  'engine.stage.finished': {
    fields: {
      stage: [
        'config',
        'directories',
        'database',
        'initialize',
        'listen',
        'shutdown',
        'legacy-backfill',
        'draft-mirror',
        'draft-import',
      ],
      durationMs: 'duration',
      err: 'error',
    },
  },
  'auth.pairing': { fields: { accepted: 'boolean' } },
  'auth.account.signin': {
    fields: {
      provider: ['gmail', 'imap'],
      outcome: ['created', 'updated', 'failed'],
      err: 'error',
    },
  },
  'deploy.migration.started': { fields: {} },
  'deploy.migration.applied': { fields: { schemaVersion: 'count' } },
  'deploy.migration.succeeded': { fields: { ...outcome, schemaVersion: 'count' } },
  'deploy.migration.failed': { fields: { ...failure, stage: ['verify', 'backup', 'apply'] } },
  'deploy.backup.succeeded': { fields: { ...outcome, stage: ['pre-migration', 'nightly'] } },
  'deploy.backup.failed': { fields: { ...failure, stage: ['pre-migration', 'nightly'] } },
  'sync.cycle.succeeded': {
    fields: { ...outcome, provider: ['gmail', 'imap'], phase: syncPhases },
  },
  'sync.cycle.failed': { fields: { ...failure, provider: ['gmail', 'imap'], phase: syncPhases } },
  'sync.gmail.history.reset': { fields: {} },
  'sync.gmail.history.reconciled': { fields: { count: 'count' } },
  'sync.gmail.request.retry': {
    fields: { status: 'count', attempt: 'count', durationMs: 'duration' },
  },
  'sync.gmail.watch.finished': { fields: { ok: 'boolean', err: 'error' } },
  'sync.gmail.pubsub.succeeded': { fields: { ...outcome, operation: pubSubOperations } },
  'sync.gmail.pubsub.failed': { fields: { ...failure, operation: pubSubOperations } },
  'sync.imap.idle.connected': { fields: { ...outcome, mode: ['idle', 'poll'] } },
  'sync.imap.idle.reconnect': {
    fields: { ...failure, retryMs: 'duration', mode: ['idle', 'poll'] },
  },
  'sync.imap.writeback.succeeded': { fields: outcome },
  'sync.imap.writeback.failed': { fields: failure },
  'sync.imap.writeback.verification': {
    fields: {
      stage: [
        'missing-source-hash',
        'missing-message-id',
        'open-destination',
        'missing-uid-state',
        'missing-snapshot',
        'changed-validity',
        'no-candidates',
        'candidate-download',
        'ambiguous-match',
        'no-match',
        'verify',
        'remove-source',
        'incomplete-copyuid',
        'assigned-uid',
      ],
      count: 'count',
      err: 'error',
    },
  },
  'sync.imap.attachment.failed': { fields: failure },
  'purge.job.succeeded': { fields: outcome },
  'purge.job.failed': { fields: failure },
  'outbox.succeeded': { fields: { ...outcome, stage: outboxStages } },
  'outbox.failed': { fields: { ...failure, stage: outboxStages } },
  'mutation.retry': { fields: { attempt: 'count', durationMs: 'duration', err: 'error' } },
  'mutation.action.finished': {
    fields: {
      outcome: ['applied', 'partial', 'failed'],
      durationMs: 'duration',
      recovered: 'boolean',
    },
  },
  'mutation.worker.finished': { fields: { ...outcome, err: 'error' } },
  'http.stream.opened': { fields: { transport: transports } },
  'http.stream.closed': {
    fields: {
      transport: transports,
      reason: ['shutdown', 'client', 'authorization', 'failed'],
      durationMs: 'duration',
      err: 'error',
    },
  },
  'engine.runtime.failed': {
    fields: { source: ['console', 'uncaught'], count: 'count', err: 'error' },
  },
  'draft.mirror.succeeded': { fields: { ...outcome, stage: ['push', 'remove'] } },
  'draft.mirror.failed': { fields: { ...failure, stage: ['push', 'remove'] } },
  'avatar.cache.failed': { fields: { stage: ['open', 'write'], err: 'error' } },
  'avatar.lookup.finished': { fields: { outcome: ['hit', 'miss', 'failed'], err: 'error' } },
  'http.request': {
    fields: {
      method: methods,
      route: 'route',
      status: 'status',
      durationMs: 'duration',
      err: 'error',
    },
  },
} as const
