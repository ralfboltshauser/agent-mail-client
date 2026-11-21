import { mkdirSync } from 'node:fs'
import { serve } from '@hono/node-server'
import { createPairingCode } from './auth/tokens.ts'
import { BlobStore } from './blobs.ts'
import { databasePath, loadConfig } from './config.ts'
import { Sealer } from './crypto.ts'
import { migrate, openDatabase } from './db/database.ts'
import { createApp } from './http/app.ts'
import { createLogger } from './log.ts'
import { Drafts } from './mail/drafts.ts'
import { Mutations } from './mail/mutations.ts'
import { MailQueries } from './mail/queries.ts'
import { MailStore } from './mail/store.ts'
import { loadOAuthClient, type OAuthClient } from './providers/gmail/oauth.ts'
import { SyncManager } from './sync/manager.ts'
import { VERSION } from './version.ts'

const USAGE = `amc-engine ${VERSION}

Usage:
  amc-engine serve                 Run the Engine (default)
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
  const db = openDatabase(databasePath(config))
  const version = migrate(db, { backupDir: config.backupDir, log })

  switch (command) {
    case 'migrate':
      console.log(`Schema version ${version}`)
      return
    case 'pair': {
      const kind = rest.includes('--desktop') ? 'desktop' : 'cli'
      const code = createPairingCode(db, kind)
      console.log(`Pairing code for the ${kind === 'desktop' ? 'desktop app' : 'amc CLI'}: ${code}`)
      console.log('It works once and expires in 10 minutes.')
      return
    }
    case 'serve': {
      const sealer = Sealer.fromSecretsDir(config.secretsDir)
      const blobs = new BlobStore(config.blobDir)
      const snoozeEnabled = config.features.snooze
      const store = new MailStore(db, blobs, { snoozeEnabled })
      const queries = new MailQueries(db, snoozeEnabled)
      let oauth: OAuthClient | null = null
      const oauthClient = () => {
        oauth ??= loadOAuthClient(config.secretsDir)
        return oauth
      }
      const sync = new SyncManager({ db, store, sealer, log, oauthClient, snoozeEnabled })
      const drafts = new Drafts(db, store, (accountId) => sync.gmailApi(accountId))
      const mutations = new Mutations(store, (accountId) => sync.gmailApi(accountId), log, {
        snoozeEnabled,
      })
      const app = createApp({
        db,
        config,
        log,
        mutations,
        mail: { db, store, queries, blobs, sealer, sync, oauthClient, drafts, log },
      })
      const server = serve({
        fetch: app.fetch,
        hostname: config.listen.host,
        port: config.listen.port,
      })
      log.info({ version: VERSION, schemaVersion: version, ...config.listen }, 'engine listening')
      sync.start()
      mutations.start()
      const shutdown = (signal: string) => {
        log.info({ signal }, 'shutting down')
        server.close(async () => {
          await Promise.all([mutations.stop(), sync.stop()])
          db.close()
          process.exit(0)
        })
        setTimeout(() => process.exit(1), 10_000).unref()
      }
      process.on('SIGTERM', () => shutdown('SIGTERM'))
      process.on('SIGINT', () => shutdown('SIGINT'))
      return
    }
    default:
      console.error(`Unknown command: ${command}\n\n${USAGE}`)
      process.exitCode = 2
  }
}

main(process.argv.slice(2)).catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
})
