import { setMaxListeners } from 'node:events'
import { mkdirSync } from 'node:fs'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { type EventFields, newRunId } from '@amc/observability'
import { serve } from '@hono/node-server'
import { createPairingCode } from './auth/tokens.ts'
import { BlobStore } from './blobs.ts'
import { databasePath, loadConfig } from './config.ts'
import { Sealer } from './crypto.ts'
import { backupDatabase, lockDatabaseFiles, restoreDatabase } from './db/backups.ts'
import { migrate, openDatabase } from './db/database.ts'
import { EngineDiagnostics, OperationStatus } from './db/diagnostics.ts'
import { createApp } from './http/app.ts'
import { serveComposerSocket } from './http/composer-socket.ts'
import { senderAvatarRoutes } from './http/sender-avatars.ts'
import { triageRoutes } from './http/triage.ts'
import { createLogger, type Logger } from './log.ts'
import { SenderAvatars } from './mail/avatars/index.ts'
import { openAvatarIndex } from './mail/avatars/store.ts'
import { gmailDelivery, imapDelivery, imapDraftMirror, publishSent } from './mail/delivery.ts'
import { Drafts } from './mail/drafts.ts'
import { Mutations } from './mail/mutations.ts'
import { Outbox } from './mail/outbox.ts'
import { MailQueries } from './mail/queries.ts'
import { MailStore } from './mail/store.ts'
import { correctionActions, markConfirmedReply } from './mail/triage/corrections.ts'
import { ERASURE_LEDGER_FILE, openErasureLedger } from './mail/triage/erasure.ts'
import { backfillLegacyBatch } from './mail/triage/legacy.ts'
import { startPurgeMaintenance } from './mail/triage/purge-maintenance.ts'
import { loadOAuthClient, type OAuthClient } from './providers/gmail/oauth.ts'
import { gmailPubSub } from './providers/gmail/pubsub.ts'
import { SyncManager } from './sync/manager.ts'
import { VERSION } from './version.ts'

declare const AMC_COMPOSER_SCRIPT: string

async function composerScript(): Promise<string> {
  if (typeof AMC_COMPOSER_SCRIPT !== 'undefined') return AMC_COMPOSER_SCRIPT
  // Source-mode development uses the same browser build as the self-contained release.
  const packageName = 'esbuild'
  const { build } = (await import(packageName)) as typeof import('esbuild')
  const result = await build({
    entryPoints: [fileURLToPath(new URL('./http/composer-editor.ts', import.meta.url))],
    bundle: true,
    format: 'esm',
    write: false,
  })
  return result.outputFiles[0]?.text ?? ''
}

const USAGE = `amc-engine ${VERSION}

Usage:
  amc-engine serve                 Run the Engine (default)
  amc-engine backup                Write and verify a nightly database backup
  amc-engine restore <file>        Replace the database while the Engine is stopped
  amc-engine migrate               Apply database migrations and exit
  amc-engine pair [--desktop]      Print a one-time code to pair the amc CLI (or the desktop app)

The config file is read from $AMC_CONFIG or /etc/amc/config.json.`

type EngineStage = EventFields<'engine.stage.finished'>['stage']

function recordStage<T>(log: Logger | undefined, stage: EngineStage, run: () => T): T {
  const start = performance.now()
  try {
    const result = run()
    log?.log('info', 'engine.stage.finished', { stage, durationMs: performance.now() - start })
    return result
  } catch (err) {
    log?.log('error', 'engine.stage.finished', {
      stage,
      durationMs: performance.now() - start,
      err,
    })
    throw err
  }
}

async function main(argv: string[]) {
  const [command = 'serve', ...rest] = argv
  if (command === '--help' || command === '-h' || command === 'help') {
    console.log(USAGE)
    return
  }
  if (command === '--version') {
    console.log(VERSION)
    return
  }

  const journal =
    command === 'serve' ||
    ((command === 'backup' || command === 'migrate') && rest.includes('--journal'))
  const bootstrap = journal ? createLogger() : undefined
  const config = recordStage(bootstrap, 'config', loadConfig)
  const logRoutes = new Set<string>()
  const log = createLogger(journal ? config.logLevel : 'silent', logRoutes)
  if (journal) {
    const consoleStatus = new OperationStatus()
    // Parser and transport dependencies can write untrusted text to console, even in quiet mode.
    // Drop their text and structured arguments at the service boundary.
    const dependencyLog = (...args: unknown[]) => {
      const err = args.find((arg) => arg instanceof Error) ?? new Error()
      const count = consoleStatus.failure(err)
      if (count) log.log('warn', 'engine.runtime.failed', { source: 'console', count, err })
    }
    console.error = console.warn = console.info = console.log = console.debug = dependencyLog
    process.on('uncaughtException', (err) => {
      log.log('error', 'engine.runtime.failed', { source: 'uncaught', count: 1, err })
      process.exitCode = 1
      // Fatal service exceptions must end the process after pending journal writes drain.
      process.stdout.write('', () => process.exit(1))
    })
  }
  const diagnostics = new EngineDiagnostics()
  recordStage(journal ? log : undefined, 'directories', () => {
    for (const dir of [config.dataDir, config.blobDir, config.backupDir]) {
      mkdirSync(dir, { recursive: true, mode: 0o700 })
    }
  })
  const dbPath = databasePath(config)
  if (command === 'restore') {
    const [source] = rest
    if (!source || rest.length !== 1) throw new Error('Usage: amc-engine restore <file>')
    process.env.SQLITE_TMPDIR = config.dataDir
    const previous = restoreDatabase(source, dbPath)
    console.log(`Restored ${dbPath}`)
    if (previous) console.log(`Previous database saved at ${previous}`)
    return
  }

  if (command === 'backup') {
    const backupLog = log.with({ runId: newRunId() })
    const start = performance.now()
    try {
      const guard = lockDatabaseFiles(config.dataDir)
      try {
        process.env.SQLITE_TMPDIR = config.backupDir
        const target = backupDatabase(dbPath, config.backupDir)
        if (!journal) console.log(`Verified backup written to ${target}`)
        backupLog.log('info', 'deploy.backup.succeeded', {
          stage: 'nightly',
          durationMs: performance.now() - start,
          count: 1,
          recovered: false,
        })
      } finally {
        guard.close()
      }
    } catch (err) {
      backupLog.log('error', 'deploy.backup.failed', {
        stage: 'nightly',
        durationMs: performance.now() - start,
        count: 1,
        err,
      })
      throw err
    }
    return
  }

  process.env.SQLITE_TMPDIR = config.dataDir
  const { guard, db } = recordStage(journal ? log : undefined, 'database', () => {
    const guard = lockDatabaseFiles(config.dataDir)
    try {
      return { guard, db: openDatabase(dbPath) }
    } catch (err) {
      guard.close()
      throw err
    }
  })
  const version = migrate(db, { backupDir: config.backupDir, log, status: diagnostics.migrations })

  switch (command) {
    case 'migrate':
      db.close()
      guard.close()
      if (!journal) console.log(`Schema version ${version}`)
      return
    case 'pair': {
      const kind = rest.includes('--desktop') ? 'desktop' : 'cli'
      const code = createPairingCode(db, kind)
      db.close()
      guard.close()
      console.log(`Pairing code for the ${kind === 'desktop' ? 'desktop app' : 'amc CLI'}: ${code}`)
      console.log('It works once and expires in 10 minutes.')
      return
    }
    case 'serve': {
      const initializing = performance.now()
      try {
        const closeErasureLedger = openErasureLedger(db, join(config.dataDir, ERASURE_LEDGER_FILE))
        const bridge = setInterval(() => {
          try {
            if (!backfillLegacyBatch(db)) clearInterval(bridge)
          } catch (err) {
            clearInterval(bridge)
            log.log('error', 'engine.stage.finished', {
              stage: 'legacy-backfill',
              durationMs: 0,
              err,
            })
          }
        }, 100)
        bridge.unref()

        const sealer = Sealer.fromSecretsDir(config.secretsDir)
        const blobs = new BlobStore(config.blobDir)
        const snoozeEnabled = config.features.snooze
        const store = new MailStore(db, blobs)
        const queries = new MailQueries(db, snoozeEnabled, blobs)
        let oauth: OAuthClient | null = null
        const oauthClient = () => {
          oauth ??= loadOAuthClient(config.secretsDir)
          return oauth
        }
        const sync = new SyncManager({
          db,
          store,
          sealer,
          log,
          diagnostics,
          oauthClient,
          gmailPubSub: config.gmailPubSubProject
            ? gmailPubSub(config.gmailPubSubProject, config.secretsDir)
            : undefined,
        })
        const drafts = new Drafts(
          db,
          store,
          (accountId) => {
            const gmail = sync.gmailApi(accountId)
            if (gmail) return gmail
            const imap = sync.imapProvider(accountId)
            return imap
              ? imapDraftMirror(imap, () => sync.imapProvider(accountId)?.draftEndpoint)
              : null
          },
          log,
        )
        // The durable claim must reach disk before a provider may accept a send.
        db.exec('PRAGMA synchronous = FULL')
        const outbox = new Outbox(
          db,
          (accountId) => {
            const gmail = sync.gmailApi(accountId)
            if (gmail) return gmailDelivery(gmail)
            const imap = sync.imapProvider(accountId)
            return imap ? imapDelivery(imap) : null
          },
          (message, id, receipt) => {
            publishSent(store, drafts, message, id, receipt)
            markConfirmedReply(store, message, id, receipt)
          },
          Date.now,
          { log, status: diagnostics.outbox },
        )
        const mutations = new Mutations(store, (accountId) => sync.gmailApi(accountId), log, {
          snoozeEnabled,
          imap: (accountId, work) => sync.organiseImap(accountId, work),
        })
        const stopping = new AbortController()
        setMaxListeners(0, stopping.signal)
        let editorScript: Promise<string> | undefined
        const avatars = new SenderAvatars(openAvatarIndex(config.dataDir, dbPath, log), log, {
          enabled: process.env.AMC_REMOTE_AVATARS !== '0',
          shutdown: stopping.signal,
        })
        const app = createApp({
          db,
          config,
          log,
          logRoutes,
          diagnostics,
          mutations,
          outbox,
          shutdownSignal: stopping.signal,
          smartInbox: {
            avatars: senderAvatarRoutes(db, avatars),
            triage: triageRoutes(db),
            ownerActions: correctionActions(store),
          },
          composerScript: () => {
            editorScript ??= composerScript()
            return editorScript
          },
          mail: { db, store, queries, blobs, sealer, sync, oauthClient, drafts, log },
        })
        let stopPurgeMaintenance: (() => Promise<void>) | undefined
        const listening = performance.now()
        const server = serve(
          {
            createServer,
            fetch: app.fetch,
            hostname: config.listen.host,
            port: config.listen.port,
          },
          () => {
            stopPurgeMaintenance = startPurgeMaintenance(db, dbPath, log, diagnostics.purge)
            log.log('info', 'engine.stage.finished', {
              stage: 'listen',
              durationMs: performance.now() - listening,
            })
          },
        )
        const closeComposer = serveComposerSocket(
          server as ReturnType<typeof createServer>,
          config,
          db,
          drafts,
          log,
        )
        server.once('error', (err) => {
          log.log('error', 'engine.stage.finished', {
            stage: 'listen',
            durationMs: performance.now() - listening,
            err,
          })
          process.exit(1)
        })
        sync.start()
        mutations.start()
        const sends = setInterval(() => {
          void outbox.runDue().catch(() => {
            // The lane records the failure once even when multiple timer ticks await it.
          })
        }, 500)
        const mirrorStatus = new OperationStatus()
        const importStatus = new OperationStatus()
        let mirroring: Promise<void> | undefined
        const mirrors = setInterval(() => {
          mirroring ??= drafts
            .mirrorPending()
            .then(() => {
              if (mirrorStatus.success().recovered)
                log.log('info', 'engine.stage.finished', { stage: 'draft-mirror', durationMs: 0 })
            })
            .catch((err) => {
              if (mirrorStatus.failure(err))
                log.log('error', 'engine.stage.finished', {
                  stage: 'draft-mirror',
                  durationMs: 0,
                  err,
                })
            })
            .finally(() => {
              mirroring = undefined
            })
        }, 3000)
        let pullingDrafts: Promise<unknown> | undefined
        const imports = setInterval(() => {
          pullingDrafts ??= Promise.allSettled(
            queries.accounts().map(async ({ id }) => {
              const api = sync.gmailApi(id)
              if (api) await drafts.pullGmail(id, api)
              else {
                const imap = sync.imapProvider(id)
                if (imap) await drafts.pullImap(id, imap)
              }
            }),
          )
            .then((results) => {
              const failure = results.find((result) => result.status === 'rejected')
              if (failure) {
                if (importStatus.failure(failure.reason))
                  log.log('error', 'engine.stage.finished', {
                    stage: 'draft-import',
                    durationMs: 0,
                    err: failure.reason,
                  })
              } else if (importStatus.success().recovered) {
                log.log('info', 'engine.stage.finished', { stage: 'draft-import', durationMs: 0 })
              }
            })
            .finally(() => {
              pullingDrafts = undefined
            })
        }, 30_000)
        const shutdown = () => {
          if (stopping.signal.aborted) return
          const start = performance.now()
          const report = (err?: unknown) =>
            log.log(err ? 'error' : 'info', 'engine.stage.finished', {
              stage: 'shutdown',
              durationMs: performance.now() - start,
              err,
            })
          clearInterval(bridge)
          clearInterval(sends)
          clearInterval(mirrors)
          clearInterval(imports)
          closeComposer()
          const httpClosed = new Promise<void>((resolve, reject) => {
            server.close((error) => (error ? reject(error) : resolve()))
          })
          stopping.abort()
          const timeout = setTimeout(() => {
            report(new DOMException('The operation was aborted due to timeout', 'TimeoutError'))
            process.exit(1)
          }, 10_000)
          void Promise.allSettled([
            httpClosed.finally(() => mutations.stop()),
            sync.stop(),
            stopPurgeMaintenance?.(),
            outbox.waitForIdle(),
            mirroring,
            pullingDrafts,
          ])
            .then((results) => {
              clearTimeout(timeout)
              const failure = results.find((result) => result.status === 'rejected')
              if (failure) {
                report(failure.reason)
                process.exit(1)
              }
              closeErasureLedger()
              db.close()
              guard.close()
              report()
              process.exit(0)
            })
            .catch((err) => {
              report(err)
              process.exit(1)
            })
        }
        process.on('SIGTERM', shutdown)
        process.on('SIGINT', shutdown)
        log.log('info', 'engine.stage.finished', {
          stage: 'initialize',
          durationMs: performance.now() - initializing,
        })
        return
      } catch (err) {
        log.log('error', 'engine.stage.finished', {
          stage: 'initialize',
          durationMs: performance.now() - initializing,
          err,
        })
        throw err
      }
    }
    default:
      db.close()
      guard.close()
      console.error(`Unknown command: ${command}\n\n${USAGE}`)
      process.exitCode = 2
  }
}

const args = process.argv.slice(2)
main(args).catch((error: unknown) => {
  const command = args[0] ?? 'serve'
  if (
    command !== 'serve' &&
    !((command === 'backup' || command === 'migrate') && args.includes('--journal'))
  ) {
    console.error(error instanceof Error ? error.message : error)
  }
  process.exit(1)
})
