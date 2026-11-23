import { setMaxListeners } from 'node:events'
import { mkdirSync } from 'node:fs'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { serve } from '@hono/node-server'
import { createPairingCode } from './auth/tokens.ts'
import { BlobStore } from './blobs.ts'
import { databasePath, loadConfig } from './config.ts'
import { Sealer } from './crypto.ts'
import { backupDatabase, lockDatabaseFiles, restoreDatabase } from './db/backups.ts'
import { migrate, openDatabase } from './db/database.ts'
import { createApp } from './http/app.ts'
import { serveComposerSocket } from './http/composer-socket.ts'
import { senderAvatarRoutes } from './http/sender-avatars.ts'
import { triageRoutes } from './http/triage.ts'
import { createLogger } from './log.ts'
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

  const config = loadConfig()
  const log = createLogger(config.logLevel)
  for (const dir of [config.dataDir, config.blobDir, config.backupDir]) {
    mkdirSync(dir, { recursive: true, mode: 0o700 })
  }
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

  const guard = lockDatabaseFiles(config.dataDir)
  if (command === 'backup') {
    try {
      process.env.SQLITE_TMPDIR = config.backupDir
      console.log(`Verified backup written to ${backupDatabase(dbPath, config.backupDir)}`)
    } finally {
      guard.close()
    }
    return
  }

  process.env.SQLITE_TMPDIR = config.dataDir
  const db = openDatabase(dbPath)
  const version = migrate(db, { backupDir: config.backupDir, log })

  switch (command) {
    case 'migrate':
      db.close()
      guard.close()
      console.log(`Schema version ${version}`)
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
      const closeErasureLedger = openErasureLedger(db, join(config.dataDir, ERASURE_LEDGER_FILE))
      const bridge = setInterval(() => {
        try {
          if (!backfillLegacyBatch(db)) clearInterval(bridge)
        } catch {
          clearInterval(bridge)
          log.error('Legacy triage history backfill paused until Engine restart')
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
        oauthClient,
        gmailPubSub: config.gmailPubSubProject
          ? gmailPubSub(config.gmailPubSubProject, config.secretsDir)
          : undefined,
      })
      const drafts = new Drafts(db, store, (accountId) => {
        const gmail = sync.gmailApi(accountId)
        if (gmail) return gmail
        const imap = sync.imapProvider(accountId)
        return imap
          ? imapDraftMirror(imap, () => sync.imapProvider(accountId)?.draftEndpoint)
          : null
      })
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
      const server = serve(
        {
          createServer,
          fetch: app.fetch,
          hostname: config.listen.host,
          port: config.listen.port,
        },
        () => {
          stopPurgeMaintenance = startPurgeMaintenance(db, dbPath, log)
          log.info(
            { version: VERSION, schemaVersion: version, ...config.listen },
            'engine listening',
          )
        },
      )
      const closeComposer = serveComposerSocket(
        server as ReturnType<typeof createServer>,
        config,
        db,
        drafts,
      )
      sync.start()
      mutations.start()
      const sends = setInterval(() => {
        void outbox.runDue().catch(() => log.error('Could not advance the Outbox'))
      }, 500)
      let mirroring: Promise<void> | undefined
      const mirrors = setInterval(() => {
        mirroring ??= drafts
          .mirrorPending()
          .catch(() => log.error('Could not mirror drafts'))
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
        ).finally(() => {
          pullingDrafts = undefined
        })
      }, 30_000)
      const shutdown = (signal: string) => {
        if (stopping.signal.aborted) return
        log.info({ signal }, 'shutting down')
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
          log.error({ signal }, 'Engine shutdown timed out')
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
            if (results.some((result) => result.status === 'rejected')) {
              log.error({ signal }, 'Could not drain Engine work during shutdown')
              process.exit(1)
            }
            closeErasureLedger()
            db.close()
            guard.close()
            process.exit(0)
          })
          .catch(() => {
            log.error({ signal }, 'Could not close the Engine database during shutdown')
            process.exit(1)
          })
      }
      process.on('SIGTERM', () => shutdown('SIGTERM'))
      process.on('SIGINT', () => shutdown('SIGINT'))
      return
    }
    default:
      db.close()
      guard.close()
      console.error(`Unknown command: ${command}\n\n${USAGE}`)
      process.exitCode = 2
  }
}

main(process.argv.slice(2)).catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
})
