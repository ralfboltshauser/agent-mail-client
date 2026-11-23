import {
  createLogger as createStructuredLogger,
  type Level,
  resolveLogLevel,
  type Sink,
} from '@amc/observability'
import { stackFilePaths, stdoutSink } from '@amc/observability/node'

export type { Logger } from '@amc/observability'

declare const AMC_ENGINE_STACK_FILES: string[]

// The linked source map resolves ../src relative to the installed bundle.
const bundle = new URL(import.meta.url)
const sourceRoot =
  typeof AMC_ENGINE_STACK_FILES === 'undefined' ? new URL('./', bundle) : new URL('../src/', bundle)
const sources =
  typeof AMC_ENGINE_STACK_FILES === 'undefined'
    ? [
        'main.ts',
        'log.ts',
        'db/database.ts',
        'db/backups.ts',
        'http/app.ts',
        'http/mail.ts',
        'http/sync.ts',
        'http/composer-socket.ts',
        'sync/manager.ts',
        'providers/gmail/http.ts',
        'providers/gmail/sync.ts',
        'providers/gmail/pubsub.ts',
        'providers/imap/client.ts',
        'providers/imap/sync.ts',
        'providers/imap/organise.ts',
        'mail/outbox.ts',
        'mail/mutations.ts',
      ]
    : AMC_ENGINE_STACK_FILES
const stackFiles = stackFilePaths([
  [bundle, 'engine'],
  ...sources.map((source) => [new URL(source, sourceRoot), source] as const),
])

export function createLogger(
  level: Level | 'silent' = 'info',
  routes?: ReadonlySet<string>,
  sink: Sink = stdoutSink,
) {
  return createStructuredLogger({
    component: 'engine',
    level: resolveLogLevel(process.env.AMC_LOG_LEVEL, level === 'silent' ? 'info' : level),
    sink: level === 'silent' ? () => {} : sink,
    routes,
    stackFiles,
  })
}
