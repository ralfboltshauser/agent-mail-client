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
import {
  connectImap,
  createImapClient,
  ImapAuthError,
  type ImapClientFactory,
  type ImapCredentials,
} from '../providers/imap/client.ts'
import { ImapProvider } from '../providers/imap/provider.ts'
import { ImapAccountSync } from '../providers/imap/sync.ts'

export interface SyncManagerOptions {
  db: Db
  store: MailStore
  sealer: Sealer
  log: Logger
  oauthClient: () => OAuthClient
  /** Overridable for tests. */
  gmailApi?: (tokens: AccessTokens) => GmailApi
  imapClient?: ImapClientFactory
  pollMs?: number
  imapPollMs?: number
  labelsEveryMs?: number
  snoozeEnabled?: boolean
}

interface Runner {
  stop: () => void
  done: Promise<void>
  api?: GmailApi
}

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal.aborted) return resolve()
    const finish = () => {
      clearTimeout(timer)
      signal.removeEventListener('abort', finish)
      resolve()
    }
    const timer = setTimeout(finish, ms)
    signal.addEventListener('abort', finish, { once: true })
  })

/**
 * Runs one sync loop per Account: backfill in the background, incremental every 15 seconds,
 * Labels every five minutes, with backoff on errors and a stop on revoked sign-ins.
 * Emits `change` whenever the store may have changed, for live Clients.
 */
export class SyncManager extends EventEmitter<{ change: [] }> {
  readonly #o: Required<Omit<SyncManagerOptions, 'gmailApi' | 'imapClient'>> &
    Pick<SyncManagerOptions, 'gmailApi' | 'imapClient'>
  readonly #runners = new Map<string, Runner>()
  readonly #paused = new Map<string, Promise<void>>()
  #stopping = false

  constructor(options: SyncManagerOptions) {
    super()
    this.#o = {
      pollMs: 15_000,
      imapPollMs: 2 * 60_000,
      labelsEveryMs: 5 * 60_000,
      snoozeEnabled: false,
      ...options,
    }
  }

  start(): void {
    this.#stopping = false
    for (const row of listAccountRows(this.#o.db)) {
      if (row.status !== 'auth_expired') this.startAccount(row.id)
    }
  }

  /** The Gmail API client of a running Account (for lazy attachment fetches). */
  gmailApi(accountId: string): GmailApi | null {
    return this.#runners.get(accountId)?.api ?? null
  }

  imapProvider(accountId: string): ImapProvider | null {
    const account = getAccountRow(this.#o.db, accountId)
    if (account?.kind !== 'imap' || account.status === 'auth_expired') return null
    return new ImapProvider(
      this.#o.sealer.open<ImapCredentials>(account.credentials),
      this.#o.imapClient,
    )
  }

  async withImapPaused<T>(address: string, run: () => Promise<T>): Promise<T> {
    const key = address.toLowerCase()
    const previous = this.#paused.get(key)
    let finish: () => void = () => {}
    const ready = new Promise<void>((resolve) => {
      finish = resolve
    })
    this.#paused.set(key, ready)
    const account = () =>
      this.#o.db
        .prepare(
          "SELECT id, status FROM account WHERE address = ? COLLATE NOCASE AND kind = 'imap'",
        )
        .get(address) as { id: string; status: string } | undefined
    try {
      await previous
      const current = account()
      const runner = current && this.#runners.get(current.id)
      runner?.stop()
      await runner?.done
      if (current) this.#runners.delete(current.id)
      return await run()
    } finally {
      finish()
      if (this.#paused.get(key) === ready) {
        this.#paused.delete(key)
        const current = account()
        if (current && current.status !== 'auth_expired') this.startAccount(current.id)
      }
    }
  }

  async imapAttachment(accountId: string, attachmentId: string): Promise<string | null> {
    const { db, store, sealer } = this.#o
    const account = getAccountRow(db, accountId)
    if (account?.kind !== 'imap' || account.status === 'auth_expired') return null
    return this.withImapPaused(account.address, async () => {
      const current = getAccountRow(db, accountId)
      if (current?.kind !== 'imap' || current.status === 'auth_expired') return null
      const attachment = db
        .prepare(
          `SELECT a.blob, a.provider_attachment AS part, a.message_id
           FROM attachment a JOIN message m ON m.id = a.message_id
           WHERE a.id = ? AND m.account_id = ?`,
        )
        .get(attachmentId, accountId) as
        | { blob: string | null; part: string | null; message_id: string }
        | undefined
      if (!attachment || attachment.blob) return attachment?.blob ?? null
      if (!attachment.part) return null

      const locations = db.prepare(
        `SELECT path_key, validity, uid FROM imap_location
         WHERE message_id = ? AND account_id = ? ORDER BY path_key, validity, uid`,
      )
      const attempted = new Set<string>()
      const credentials = sealer.open<ImapCredentials>(current.credentials)
      let client: ReturnType<ImapClientFactory> | undefined
      try {
        for (;;) {
          const rows = (
            locations.all(attachment.message_id, accountId) as {
              path_key: string
              validity: string
              uid: number
            }[]
          ).filter(
            ({ path_key, validity, uid }) => !attempted.has(`${path_key}:${validity}:${uid}`),
          )
          if (!rows.length) return null
          for (const { path_key, validity, uid } of rows) {
            attempted.add(`${path_key}:${validity}:${uid}`)
            try {
              if (!client?.usable) {
                client?.close()
                client = (this.#o.imapClient ?? createImapClient)(credentials.imap)
                await connectImap(client)
              }
              const box = await client.mailboxOpen(decodeURIComponent(path_key), { readOnly: true })
              if (String(box.uidValidity) !== validity) continue
              const { content } = await client.download(String(uid), attachment.part, {
                uid: true,
                decodeText: false,
              })
              if (!content) continue
              const { hash, size } = await store.blobs.putStream(content)
              db.prepare('UPDATE attachment SET blob = ?, size = ? WHERE id = ?').run(
                hash,
                size,
                attachmentId,
              )
              return hash
            } catch {
              // Folder and UID failures are local to this copy. Try the remaining locations.
            }
          }
        }
      } finally {
        client?.close()
      }
    })
  }

  startAccount(accountId: string): void {
    const row = getAccountRow(this.#o.db, accountId)
    if (
      !row ||
      this.#stopping ||
      (row.kind === 'imap' && this.#paused.has(row.address.toLowerCase()))
    )
      return
    const previous = this.#runners.get(accountId)
    previous?.stop()
    if (row.kind === 'imap') {
      this.#startImap(row, previous)
      return
    }
    const { db, store, log } = this.#o
    const tokens = new AccessTokens(
      this.#o.oauthClient(),
      this.#o.sealer.open<GmailCredentials>(row.credentials),
    )
    const api = this.#o.gmailApi
      ? this.#o.gmailApi(tokens)
      : new GmailHttpApi(tokens, fetch, {
          onRetry: (info) => log.warn({ account: accountId, ...info }, 'gmail retry'),
        })
    const sync = new GmailAccountSync(
      api,
      store,
      new DbAccountState(db, accountId, [row.address]),
      log,
      this.#o.snoozeEnabled,
    )
    sync.onProgress = () => this.emit('change')
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

    let filling: Promise<void> | undefined
    const startBackfill = () => {
      if (!filling && !sync.backfillDone)
        filling = backfill().finally(() => {
          filling = undefined
        })
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
          else startBackfill()
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
      if (!signal.aborted) {
        startBackfill()
        await live()
        await filling
      }
    })()

    this.#runners.set(accountId, { stop: () => controller.abort(), done, api })
  }

  #startImap(row: NonNullable<ReturnType<typeof getAccountRow>>, previous?: Runner): void {
    const { db, store, log, sealer, imapPollMs } = this.#o
    const controller = new AbortController()
    const signal = controller.signal
    const done = (async () => {
      await previous?.done
      let retryMs = 5_000
      while (!signal.aborted) {
        try {
          const credentials = sealer.open<ImapCredentials>(row.credentials)
          const client = (this.#o.imapClient ?? createImapClient)(credentials.imap)
          const close = () => client.close()
          signal.addEventListener('abort', close, { once: true })
          try {
            await connectImap(client)
            if (signal.aborted) return
            const sync = new ImapAccountSync(client, store, row.id, row.address)
            let idleTime = 0
            let nextPoll = 0
            let backfilled = false
            const wait = async (ms: number) => {
              idleTime += await sync.waitForInbox(ms, signal)
              if (idleTime >= 60_000) retryMs = 5_000
            }
            const inboxWindow = async () => {
              await wait(200)
              if (signal.aborted || !client.usable) throw new Error('IMAP connection closed')
              if (sync.inboxChanged) await sync.step('inbox')
            }
            try {
              await wait(200)
              while (client.usable && !signal.aborted) {
                const mode =
                  Date.now() >= nextPoll ? 'all' : sync.inboxChanged ? 'inbox' : 'backfill'
                if (mode !== 'backfill' || !backfilled) {
                  backfilled = await sync.step(mode, inboxWindow)
                  if (signal.aborted) return
                  if (mode === 'all') nextPoll = Date.now() + imapPollMs
                  touchAccountSync(db, row.id)
                  setAccountStatus(db, store, row.id, backfilled ? 'ready' : 'backfilling')
                  this.emit('change')
                }
                const remaining = Math.max(0, nextPoll - Date.now())
                await wait(Math.min(backfilled ? 60_000 : 200, remaining))
              }
              if (signal.aborted) return
              throw new Error('IMAP connection closed')
            } finally {
              sync.dispose()
            }
          } finally {
            signal.removeEventListener('abort', close)
            close()
          }
        } catch (error) {
          if (signal.aborted) return
          if (error instanceof ImapAuthError) {
            setAccountStatus(db, store, row.id, 'auth_expired', error.message)
            this.emit('change')
            return
          }
          log.warn({ account: row.id }, 'IMAP sync failed')
          setAccountStatus(db, store, row.id, 'error', 'IMAP sync failed. The Engine will retry.')
          this.emit('change')
          await sleep(retryMs, signal)
          retryMs = Math.min(retryMs * 2, 5 * 60_000)
        }
      }
    })()
    this.#runners.set(row.id, { stop: () => controller.abort(), done })
  }

  async stop(): Promise<void> {
    this.#stopping = true
    for (const runner of this.#runners.values()) runner.stop()
    await Promise.all([...this.#runners.values()].map((r) => r.done))
    this.#runners.clear()
  }
}
