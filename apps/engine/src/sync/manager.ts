import { EventEmitter } from 'node:events'
import type { Health } from '@amc/protocol'
import { ImapFlowErrorCode } from 'imapflow/lib/errors'
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
import { GmailHttpApi, GmailHttpError } from '../providers/gmail/http.ts'
import {
  AccessTokens,
  type GmailCredentials,
  type OAuthClient,
  OAuthError,
} from '../providers/gmail/oauth.ts'
import { type GmailPubSub, GmailPubSubError } from '../providers/gmail/pubsub.ts'
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
import { ImapAccountSync, ImapIdleFailure, ImapSyncFailure } from '../providers/imap/sync.ts'
import { ManualPoll } from './manual-poll.ts'

const MANUAL_POLL_COOLDOWN_MS = 5_000
const WATCH_RENEW_MS = 24 * 60 * 60_000
const WATCH_RETRY_MS = 60_000
const PUSH_POLL_MS = 60_000
const NOTIFICATION_DEBOUNCE_MS = 250
const GMAIL_REPLACEMENT_WAIT_MS = 5_000

// Server errors can include credentials, MIME literals or addresses. Keep only known codes and
// class names alongside the Engine's own operation-specific message.
const IMAP_ERROR_CODES = new Set<string>([
  ...Object.values(ImapFlowErrorCode),
  'ECONNREFUSED',
  'ECONNRESET',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ENOTFOUND',
  'EAI_AGAIN',
  'ETIMEDOUT',
  'EPIPE',
  'CERT_HAS_EXPIRED',
  'ERR_TLS_CERT_ALTNAME_INVALID',
  'ERR_SQLITE_ERROR',
  'ENOSPC',
  'EACCES',
])

function imapErrorDetails(error: unknown) {
  const types = [ImapAuthError, ImapIdleFailure, TypeError, SyntaxError, RangeError, Error]
  const cause = error instanceof ImapSyncFailure ? (error.cause ?? error) : error
  const code = cause instanceof Error && 'code' in cause ? cause.code : undefined
  return {
    errorClass: types.find((type) => cause instanceof type)?.name ?? 'UnknownError',
    errorCode: typeof code === 'string' && IMAP_ERROR_CODES.has(code) ? code : undefined,
  }
}

export interface SyncManagerOptions {
  db: Db
  store: MailStore
  sealer: Sealer
  log: Logger
  oauthClient: () => OAuthClient
  /** Overridable for tests. */
  gmailApi?: (tokens: AccessTokens) => GmailApi
  imapClient?: ImapClientFactory
  gmailPubSub?: GmailPubSub
  pollMs?: number
  imapPollMs?: number
  labelsEveryMs?: number
}

type GmailPushHealth = NonNullable<NonNullable<Health['accounts']>[number]['gmailPush']>
type GmailPubSubHealth = NonNullable<Health['gmailPubSub']>

interface Runner {
  stop: () => void
  checkMail: () => Promise<boolean>
  done: Promise<void>
  api?: GmailApi
  gmailHealth?: () => GmailPushHealth
  gmailNotification?: (address: string, at: number) => void
  gmailWake?: () => void
  imap?: () => ImapAccountSync | undefined
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
  readonly #o: Required<Omit<SyncManagerOptions, 'gmailApi' | 'imapClient' | 'gmailPubSub'>> &
    Pick<SyncManagerOptions, 'gmailApi' | 'imapClient' | 'gmailPubSub'>
  readonly #runners = new Map<string, Runner>()
  readonly #paused = new Map<string, Promise<void>>()
  #stopping = false
  #manualCheck?: Promise<boolean>
  #nextManualCheckAt = 0
  #pubSub?: { controller: AbortController; done: Promise<void> }
  #pullHealthy = false
  #lastNotificationAt: number | null = null
  #pullErrorCount = 0
  #lastPullError: GmailPubSubHealth['lastPullError'] = null

  constructor(options: SyncManagerOptions) {
    super()
    this.#o = {
      pollMs: 15_000,
      imapPollMs: 2 * 60_000,
      labelsEveryMs: 5 * 60_000,
      ...options,
    }
  }

  start(): void {
    this.#stopping = false
    if (this.#o.gmailPubSub && !this.#pubSub) {
      const controller = new AbortController()
      const done = this.#pullGmailNotifications(this.#o.gmailPubSub, controller.signal)
      this.#pubSub = { controller, done }
    }
    for (const row of listAccountRows(this.#o.db)) {
      if (row.status !== 'auth_expired') this.startAccount(row.id)
    }
  }

  /** Coalesce owner requests across Clients through completion and a short cooldown. */
  checkMail(): Promise<boolean> {
    if (this.#stopping) return Promise.resolve(false)
    if (this.#manualCheck && Date.now() < this.#nextManualCheckAt) return this.#manualCheck
    this.#nextManualCheckAt = Infinity
    this.#manualCheck = Promise.all(
      listAccountRows(this.#o.db).map(({ id }) => this.#runners.get(id)?.checkMail() ?? false),
    ).then((results) => {
      this.#nextManualCheckAt = Date.now() + MANUAL_POLL_COOLDOWN_MS
      return results.every(Boolean)
    })
    return this.#manualCheck
  }

  gmailPubSubHealth(): GmailPubSubHealth {
    return {
      enabled: this.#o.gmailPubSub !== undefined,
      pullHealthy: this.#pullHealthy,
      lastNotificationAt: this.#lastNotificationAt,
      pullErrorCount: this.#pullErrorCount,
      lastPullError: this.#lastPullError,
    }
  }

  gmailPushHealth(accountId: string): GmailPushHealth {
    return (
      this.#runners.get(accountId)?.gmailHealth?.() ?? {
        watchExpiresAt: null,
        lastNotificationAt: null,
        pollIntervalMs: null,
      }
    )
  }

  async #pullGmailNotifications(pubSub: GmailPubSub, signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      let operation = 'pull'
      try {
        const messages = await pubSub.pull(signal)
        if (signal.aborted) return
        const receivedAt = Date.now()
        for (const { address } of messages) {
          if (!address) continue
          this.#lastNotificationAt = receivedAt
          for (const runner of this.#runners.values()) {
            runner.gmailNotification?.(address, receivedAt)
          }
        }
        // These are wake-up hints. The stored Gmail cursor and periodic poll recover missed work.
        if (messages.length) {
          operation = 'acknowledge'
          await pubSub.acknowledge(
            messages.map(({ ackId }) => ackId),
            signal,
          )
        }
        this.#pullHealthy = true
        if (!messages.length) await sleep(NOTIFICATION_DEBOUNCE_MS, signal)
      } catch (error) {
        if (signal.aborted) return
        if (this.#pullHealthy) {
          this.#pullHealthy = false
          for (const runner of this.#runners.values()) runner.gmailWake?.()
        }
        const detail =
          error instanceof GmailPubSubError
            ? error.message
            : error instanceof SyntaxError
              ? 'Invalid response'
              : error instanceof DOMException && error.name === 'TimeoutError'
                ? 'Request timed out'
                : 'Request failed'
        this.#pullErrorCount++
        this.#lastPullError = { at: Date.now(), message: `${operation}: ${detail}` }
        this.#o.log.warn({ operation, detail }, 'Gmail Pub/Sub pull failed')
        await sleep(this.#o.pollMs, signal)
      }
    }
  }

  /** The Gmail API client of a running Account (for lazy attachment fetches). */
  gmailApi(accountId: string): GmailApi | null {
    return this.#runners.get(accountId)?.api ?? null
  }

  organiseImap(
    accountId: string,
    work: (sync: ImapAccountSync) => Promise<void>,
  ): Promise<boolean> {
    return this.#runners.get(accountId)?.imap?.()?.queueOrganise(work) ?? Promise.resolve(false)
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
    const controller = new AbortController()
    const signal = controller.signal
    const manual = new ManualPoll(signal)
    const stop = () => controller.abort()
    const isCurrent = () => !signal.aborted && this.#runners.get(accountId)?.stop === stop
    const sync = new GmailAccountSync(
      api,
      store,
      new DbAccountState(db, accountId, [row.address]),
      log,
      signal,
    )
    sync.onProgress = () => {
      if (isCurrent()) this.emit('change')
    }

    const fail = (error: unknown): boolean => {
      if (!isCurrent()) return true
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
          if (!(await sync.backfillStep()) || !isCurrent()) return
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

    const pubSub = this.#o.gmailPubSub
    const address = row.address.toLowerCase()
    let watchExpiresAt: number | null = null
    let watchHealthy = false
    let lastNotificationAt: number | null = null
    let pollIntervalMs: number | null = null
    let notified = false
    let waiting: AbortController | undefined
    const wake = () => waiting?.abort()

    const renewWatch = async (topic: string) => {
      while (!signal.aborted) {
        try {
          const expiration = await api.watch(topic, signal)
          if (!isCurrent()) return
          const remaining = expiration - Date.now()
          if (!Number.isFinite(remaining) || remaining <= 0) {
            throw new Error('Gmail returned an invalid watch expiration')
          }
          watchExpiresAt = expiration
          watchHealthy = true
          log.info({ account: accountId, watchExpiresAt }, 'Gmail watch renewed')
          await sleep(Math.min(WATCH_RENEW_MS, Math.max(1_000, remaining - 60_000)), signal)
        } catch (error) {
          if (signal.aborted) return
          if (watchHealthy) {
            watchHealthy = false
            wake()
          }
          log.warn(
            {
              account: accountId,
              status: error instanceof GmailHttpError ? error.status : undefined,
            },
            'Gmail watch failed',
          )
          await sleep(WATCH_RETRY_MS, signal)
        }
      }
    }

    const live = async () => {
      let backoff = this.#o.pollMs
      let lastLabels = Date.now()
      while (!signal.aborted) {
        notified = false
        const finishCheck = manual.take()
        try {
          if (Date.now() - lastLabels > this.#o.labelsEveryMs) {
            await sync.syncLabels()
            if (!isCurrent()) return
            lastLabels = Date.now()
          }
          const changes = await sync.incremental()
          if (!isCurrent()) return
          touchAccountSync(db, accountId)
          if (sync.backfillDone) setAccountStatus(db, store, accountId, 'ready')
          else startBackfill()
          if (changes > 0) this.emit('change')
          backoff = this.#o.pollMs
          finishCheck?.(true)
        } catch (error) {
          finishCheck?.(false)
          if (fail(error)) return
          backoff = Math.min(backoff * 2, 5 * 60_000)
          pollIntervalMs = backoff
          await manual.backoff(() => sleep(backoff, signal))
          continue
        }
        if (!notified) {
          waiting = new AbortController()
          const pushWake = waiting.signal
          const healthy = this.#pullHealthy && watchHealthy && (watchExpiresAt ?? 0) > Date.now()
          const interval = healthy ? PUSH_POLL_MS : backoff
          pollIntervalMs = interval
          await manual.wait((wake) => sleep(interval, AbortSignal.any([signal, pushWake, wake])))
          waiting = undefined
        }
        if (notified)
          await manual.wait((wake) =>
            sleep(NOTIFICATION_DEBOUNCE_MS, AbortSignal.any([signal, wake])),
          )
      }
    }

    const done = (async () => {
      const wait = new AbortController()
      await (previous &&
        Promise.race([
          previous.done,
          sleep(GMAIL_REPLACEMENT_WAIT_MS, AbortSignal.any([signal, wait.signal])),
        ]).finally(() => wait.abort()))
      while (isCurrent()) {
        try {
          await sync.start()
          if (!isCurrent()) return
          setAccountStatus(db, store, accountId, sync.backfillDone ? 'ready' : 'backfilling')
          this.emit('change')
          break
        } catch (error) {
          manual.take()?.(false)
          if (fail(error)) return
          await manual.backoff(() => sleep(30_000, signal))
        }
      }
      if (isCurrent()) {
        startBackfill()
        const watching = pubSub && renewWatch(pubSub.topic)
        await live()
        await Promise.all([filling, watching])
      }
    })()

    this.#runners.set(accountId, {
      stop,
      done,
      checkMail: () => manual.request(),
      api,
      gmailHealth: () => ({
        watchExpiresAt,
        lastNotificationAt,
        pollIntervalMs: signal.aborted ? null : pollIntervalMs,
      }),
      gmailWake: pubSub ? wake : undefined,
      gmailNotification: pubSub
        ? (mailbox, at) => {
            if (signal.aborted || mailbox !== address) return
            lastNotificationAt = at
            notified = true
            wake()
          }
        : undefined,
    })
  }

  #startImap(row: NonNullable<ReturnType<typeof getAccountRow>>, previous?: Runner): void {
    const { db, store, log, sealer, imapPollMs } = this.#o
    const controller = new AbortController()
    const signal = controller.signal
    const manual = new ManualPoll(signal)
    let active: ImapAccountSync | undefined
    let useIdle = true
    const report = (failure: ImapSyncFailure, socketError?: Error) => {
      const details = imapErrorDetails(socketError ?? failure)
      const folder = failure.folder ? ` (${JSON.stringify(failure.folder).slice(1, -1)})` : ''
      const code = details.errorCode ? ` [${details.errorCode}]` : ''
      const message = `IMAP ${failure.phase}${folder}: ${failure.summary}${code}`
      const authExpired = failure.cause instanceof ImapAuthError
      const context = {
        account: row.id,
        phase: failure.phase,
        folder: failure.folder,
        ...details,
        errorMessage: failure.summary,
      }
      if (authExpired || failure instanceof ImapIdleFailure) log.warn(context, 'IMAP sync failed')
      else log.error(context, 'IMAP sync failed')
      setAccountStatus(db, store, row.id, authExpired ? 'auth_expired' : 'error', message)
      this.emit('change')
      return authExpired
    }

    const done = (async () => {
      await previous?.done
      if (signal.aborted) return
      log.info({ account: row.id, phase: 'start', folder: null }, 'IMAP runner started')
      try {
        let retryMs = 5_000
        while (!signal.aborted) {
          let phase = 'credentials'
          let summary = 'Could not open stored IMAP credentials'
          let socketError: Error | undefined
          let folder: string | null = null
          let finishCheck: ReturnType<ManualPoll['take']>
          try {
            const credentials = sealer.open<ImapCredentials>(row.credentials)
            phase = 'connect'
            summary = 'Could not connect to the IMAP server over TLS'
            const client = (this.#o.imapClient ?? createImapClient)(credentials.imap)
            let closed = false
            const close = () => {
              if (closed) return
              closed = true
              client.close()
            }
            signal.addEventListener('abort', close, { once: true })
            try {
              await connectImap(client, (error) => {
                socketError ??= error
              })
              if (signal.aborted) return
              phase = 'initialize'
              summary = 'Could not load IMAP sync state'
              const sync = new ImapAccountSync(client, store, row.id, row.address)
              active = sync
              let idleTime = 0
              let nextPoll = 0
              let backfilled = false
              const wait = async (ms: number, wake?: AbortSignal) => {
                try {
                  if (useIdle) idleTime += await sync.waitForInbox(ms, signal, wake)
                  else {
                    const start = Date.now()
                    await sleep(ms, wake ? AbortSignal.any([signal, wake]) : signal)
                    idleTime += Date.now() - start
                  }
                  if (idleTime >= 60_000) retryMs = 5_000
                } catch (error) {
                  // A server that fails the IDLE handshake can still serve ordinary commands.
                  // Retry on a fresh connection with polling for the rest of this runner.
                  if (error instanceof ImapSyncFailure) {
                    if (error instanceof ImapIdleFailure && client.usable) useIdle = false
                    throw error
                  }
                  throw new ImapIdleFailure('Could not wait for Inbox changes', error)
                }
              }
              const inboxWindow = async () => {
                await wait(200)
                if (signal.aborted || !client.usable) {
                  throw new ImapSyncFailure(
                    'idle',
                    'INBOX',
                    'Connection closed while waiting for Inbox changes',
                  )
                }
                if (sync.inboxChanged) await sync.step('inbox')
              }
              try {
                phase = 'idle'
                folder = 'INBOX'
                await wait(200)
                while (client.usable && !signal.aborted) {
                  phase = 'organise'
                  folder = null
                  summary = 'Could not process queued IMAP work'
                  if (await sync.runQueuedOrganise()) nextPoll = 0
                  if (signal.aborted || !client.usable) break
                  finishCheck = manual.take()
                  const mode =
                    finishCheck || Date.now() >= nextPoll
                      ? 'all'
                      : sync.inboxChanged
                        ? 'inbox'
                        : 'backfill'
                  if (mode !== 'backfill' || !backfilled) {
                    phase = mode
                    folder = mode === 'inbox' ? 'INBOX' : null
                    summary = 'Could not finish the sync pass'
                    backfilled = await sync.step(mode, useIdle ? inboxWindow : undefined)
                    if (signal.aborted) return
                    if (mode === 'all') nextPoll = Date.now() + imapPollMs
                    touchAccountSync(db, row.id)
                    setAccountStatus(db, store, row.id, backfilled ? 'ready' : 'backfilling')
                    this.emit('change')
                    finishCheck?.(true)
                    finishCheck = undefined
                  }
                  const remaining = Math.max(0, nextPoll - Date.now())
                  phase = useIdle ? 'idle' : 'poll'
                  folder = useIdle ? 'INBOX' : null
                  await manual.wait((wake) =>
                    wait(Math.min(backfilled ? 60_000 : 200, remaining), wake),
                  )
                }
                if (signal.aborted) return
                throw new ImapSyncFailure(phase, folder, 'IMAP connection closed')
              } finally {
                active = undefined
                sync.dispose()
              }
            } finally {
              signal.removeEventListener('abort', close)
              close()
            }
          } catch (error) {
            if (signal.aborted) return
            const failure =
              error instanceof ImapSyncFailure
                ? error
                : new ImapSyncFailure(
                    phase,
                    folder,
                    error instanceof ImapAuthError ? error.message : summary,
                    error,
                  )
            const authExpired = report(failure, socketError)
            const finish = finishCheck ?? manual.take()
            finish?.(false)
            if (authExpired) {
              controller.abort()
              return
            }
            await manual.backoff(() => sleep(retryMs, signal))
            retryMs = Math.min(retryMs * 2, 5 * 60_000)
          }
        }
      } finally {
        log.info({ account: row.id, phase: 'stop', folder: null }, 'IMAP runner stopped')
      }
    })()
    this.#runners.set(row.id, {
      stop: () => controller.abort(),
      done,
      checkMail: () => manual.request(),
      imap: () => active,
    })
  }

  async stop(): Promise<void> {
    this.#stopping = true
    this.#pubSub?.controller.abort()
    for (const runner of this.#runners.values()) runner.stop()
    await Promise.all([this.#pubSub?.done, ...[...this.#runners.values()].map((r) => r.done)])
    this.#runners.clear()
    this.#pubSub = undefined
    this.#pullHealthy = false
    this.#manualCheck = undefined
    this.#nextManualCheckAt = 0
  }
}
