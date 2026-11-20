import { EventEmitter } from 'node:events'
import {
  DbAccountState,
  getAccountRow,
  listAccountRows,
  setAccountStatus,
  touchAccountSync,
} from '../accounts.ts'
import type { Sealer } from '../crypto.ts'
import type { Db } from '../db/database.ts'
import type { Logger } from '../log.ts'
import type { MailStore } from '../mail/store.ts'
import { GmailHttpApi } from '../providers/gmail/http.ts'
import {
  AccessTokens,
  type GmailCredentials,
  type OAuthClient,
  OAuthError,
} from '../providers/gmail/oauth.ts'
import { GmailAccountSync } from '../providers/gmail/sync.ts'
import type { GmailApi } from '../providers/gmail/types.ts'

export interface SyncManagerOptions {
  db: Db
  store: MailStore
  sealer: Sealer
  log: Logger
  oauthClient: () => OAuthClient
  /** Overridable for tests. */
  gmailApi?: (tokens: AccessTokens) => GmailApi
  pollMs?: number
  labelsEveryMs?: number
}

interface Runner {
  stop: () => void
  done: Promise<void>
  api: GmailApi
}

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms)
    signal.addEventListener('abort', () => {
      clearTimeout(timer)
      resolve()
    })
  })

/**
 * Runs one sync loop per Account: backfill in the background, incremental every 15 seconds,
 * Labels every five minutes, with backoff on errors and a stop on revoked sign-ins.
 * Emits `change` whenever the store may have changed, for live Clients.
 */
export class SyncManager extends EventEmitter<{ change: [] }> {
  readonly #o: Required<Omit<SyncManagerOptions, 'gmailApi'>> & Pick<SyncManagerOptions, 'gmailApi'>
  readonly #runners = new Map<string, Runner>()

  constructor(options: SyncManagerOptions) {
    super()
    this.#o = { pollMs: 15_000, labelsEveryMs: 5 * 60_000, ...options }
  }

  start(): void {
    for (const row of listAccountRows(this.#o.db)) {
      if (row.kind === 'gmail' && row.status !== 'auth_expired') this.startAccount(row.id)
    }
  }

  /** The Gmail API client of a running Account (for lazy attachment fetches). */
  gmailApi(accountId: string): GmailApi | null {
    return this.#runners.get(accountId)?.api ?? null
  }

  startAccount(accountId: string): void {
    this.#runners.get(accountId)?.stop()
    const row = getAccountRow(this.#o.db, accountId)
    if (!row || row.kind !== 'gmail') return
    const { db, store, log } = this.#o
    const tokens = new AccessTokens(
      this.#o.oauthClient(),
      this.#o.sealer.open<GmailCredentials>(row.credentials),
    )
    const api = this.#o.gmailApi ? this.#o.gmailApi(tokens) : new GmailHttpApi(tokens)
    const sync = new GmailAccountSync(
      api,
      store,
      new DbAccountState(db, accountId, [row.address]),
      log,
    )
    const controller = new AbortController()
    const signal = controller.signal

    const fail = (error: unknown): boolean => {
      if (error instanceof OAuthError && error.needsReauth) {
        log.warn(
          { account: accountId },
          'gmail sign-in expired; waiting for the owner to sign in again',
        )
        setAccountStatus(
          db,
          store,
          accountId,
          'auth_expired',
          'Google sign-in expired or was revoked',
        )
        controller.abort()
        return true
      }
      const message = error instanceof Error ? error.message : String(error)
      log.error({ account: accountId, err: message }, 'gmail sync error')
      setAccountStatus(db, store, accountId, 'error', message)
      return false
    }

    const backfill = async () => {
      while (!signal.aborted) {
        try {
          if (!(await sync.backfillStep())) return
          setAccountStatus(db, store, accountId, 'backfilling')
          this.emit('change')
        } catch (error) {
          if (fail(error)) return
          await sleep(30_000, signal)
        }
      }
    }

    const live = async () => {
      let backoff = this.#o.pollMs
      let lastLabels = Date.now()
      while (!signal.aborted) {
        try {
          if (Date.now() - lastLabels > this.#o.labelsEveryMs) {
            await sync.syncLabels()
            lastLabels = Date.now()
          }
          const changes = await sync.incremental()
          touchAccountSync(db, accountId)
          if (sync.backfillDone) setAccountStatus(db, store, accountId, 'ready')
          if (changes > 0) this.emit('change')
          backoff = this.#o.pollMs
        } catch (error) {
          if (fail(error)) return
          backoff = Math.min(backoff * 2, 5 * 60_000)
        }
        await sleep(backoff, signal)
      }
    }

    const done = (async () => {
      while (!signal.aborted) {
        try {
          await sync.start()
          setAccountStatus(db, store, accountId, sync.backfillDone ? 'ready' : 'backfilling')
          this.emit('change')
          break
        } catch (error) {
          if (fail(error)) return
          await sleep(30_000, signal)
        }
      }
      if (!signal.aborted) await Promise.all([backfill(), live()])
    })()

    this.#runners.set(accountId, { stop: () => controller.abort(), done, api })
  }

  async stop(): Promise<void> {
    for (const runner of this.#runners.values()) runner.stop()
    await Promise.all([...this.#runners.values()].map((r) => r.done))
    this.#runners.clear()
  }
}
