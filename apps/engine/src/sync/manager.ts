import { AsyncLocalStorage } from 'node:async_hooks'
import { EventEmitter } from 'node:events'
import { type EventFields, newRunId, type RequestId, type RunId } from '@amc/observability'
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
import { EngineDiagnostics, OperationStatus } from '../db/diagnostics.ts'
import type { Logger } from '../log.ts'
import type { MailStore } from '../mail/store.ts'
import { GmailHttpApi } from '../providers/gmail/http.ts'
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
  diagnostics?: EngineDiagnostics
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
  checkMail: (requestId?: RequestId) => Promise<boolean>
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
  readonly #o: Required<
    Omit<SyncManagerOptions, 'gmailApi' | 'imapClient' | 'gmailPubSub' | 'diagnostics'>
  > &
    Pick<SyncManagerOptions, 'gmailApi' | 'imapClient' | 'gmailPubSub'>
  readonly #diagnostics: EngineDiagnostics
  readonly #cycleLog = new AsyncLocalStorage<Logger>()
  readonly #cycleRuns = new WeakMap<OperationStatus, { runId: RunId; requestId?: RequestId }>()
  readonly #writebackStatus = new OperationStatus()
  readonly #attachmentStatus = new OperationStatus()
  readonly #pullStatus = new OperationStatus()
  readonly #ackStatus = new OperationStatus()
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
    this.#diagnostics = options.diagnostics ?? new EngineDiagnostics()
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
  checkMail(requestId?: RequestId): Promise<boolean> {
    if (this.#stopping) return Promise.resolve(false)
    if (this.#manualCheck && Date.now() < this.#nextManualCheckAt) return this.#manualCheck
    this.#nextManualCheckAt = Infinity
    this.#manualCheck = Promise.all(
      listAccountRows(this.#o.db).map(
        ({ id }) => this.#runners.get(id)?.checkMail(requestId) ?? false,
      ),
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
    let runId = newRunId()
    while (!signal.aborted) {
      const log = this.#o.log.with({ runId })
      let started = performance.now()
      let operation: 'pull' | 'acknowledge' = 'pull'
      const success = (status: OperationStatus, count: number) => {
        const { recovered } = status.success()
        log.log(recovered ? 'info' : 'debug', 'sync.gmail.pubsub.succeeded', {
          operation,
          durationMs: performance.now() - started,
          count,
          recovered,
        })
      }
      try {
        const messages = await pubSub.pull(signal)
        if (signal.aborted) return
        success(this.#pullStatus, messages.length)
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
          started = performance.now()
          await pubSub.acknowledge(
            messages.map(({ ackId }) => ackId),
            signal,
          )
          if (signal.aborted) return
          success(this.#ackStatus, messages.length)
        }
        this.#diagnostics.pubSub.success()
        this.#pullHealthy = true
        runId = newRunId()
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
        this.#diagnostics.pubSub.failure(error)
        const count = (operation === 'pull' ? this.#pullStatus : this.#ackStatus).failure(error)
        if (count)
          log.log('warn', 'sync.gmail.pubsub.failed', {
            operation,
            durationMs: performance.now() - started,
            count,
            err: error,
          })
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
    const active = this.#runners.get(accountId)?.imap?.()
    if (!active) return Promise.resolve(false)
    const log = this.#o.log.with({ accountId, runId: newRunId() })
    return active.queueOrganise(async (sync) => {
      const start = performance.now()
      try {
        await log.span('sync.imap.action', (workLog) =>
          this.#cycleLog.run(workLog, () => work(sync)),
        )
        const { recovered, count } = this.#writebackStatus.success()
        log.log(recovered ? 'info' : 'debug', 'sync.imap.writeback.succeeded', {
          durationMs: performance.now() - start,
          count: count || 1,
          recovered,
        })
      } catch (err) {
        const count = this.#writebackStatus.failure(err)
        if (count)
          log.log('warn', 'sync.imap.writeback.failed', {
            durationMs: performance.now() - start,
            count,
            err,
          })
        throw err
      }
    })
  }

  imapProvider(accountId: string): ImapProvider | null {
    const account = getAccountRow(this.#o.db, accountId)
    if (account?.kind !== 'imap' || account.status === 'auth_expired') return null
    return new ImapProvider(
      this.#o.sealer.open<ImapCredentials>(account.credentials),
      this.#o.imapClient,
    )
  }

  async withImapPaused<T>(
    address: string,
    run: () => Promise<T>,
    requestId?: RequestId,
  ): Promise<T> {
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
        if (current && current.status !== 'auth_expired') this.startAccount(current.id, requestId)
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
      const log = this.#o.log.with({ accountId, runId: newRunId() })
      const started = performance.now()
      let failure: { err: unknown } | undefined
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
          if (!rows.length) {
            if (failure) {
              const count = this.#attachmentStatus.failure(failure.err)
              if (count)
                log.log('warn', 'sync.imap.attachment.failed', {
                  durationMs: performance.now() - started,
                  count,
                  err: failure.err,
                })
            }
            return null
          }
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
              this.#attachmentStatus.success()
              return hash
            } catch (err) {
              // The terminal result reports once after the alternate locations are exhausted.
              failure = { err }
            }
          }
        }
      } finally {
        client?.close()
      }
    })
  }

  async #cycle<T>(
    accountId: string,
    provider: 'gmail' | 'imap',
    phase: EventFields<'sync.cycle.failed'>['phase'],
    status: OperationStatus,
    current: () => boolean,
    work: () => Promise<T>,
    requestId?: RequestId,
  ): Promise<T> {
    const retry = this.#cycleRuns.get(status)
    const correlation = {
      runId: retry?.runId ?? newRunId(),
      requestId: retry?.requestId ?? requestId,
    }
    const log = this.#o.log.with({ accountId, ...correlation })
    const account = this.#diagnostics.account(this.#diagnostics.sync, accountId)
    const start = performance.now()
    try {
      const result = await this.#cycleLog.run(log, work)
      this.#cycleRuns.delete(status)
      if (current()) {
        account.success()
        const { recovered, count } = status.success()
        log.log(recovered ? 'info' : 'debug', 'sync.cycle.succeeded', {
          provider,
          phase,
          durationMs: performance.now() - start,
          count: recovered ? count : typeof result === 'number' ? result : Number(result === true),
          recovered,
        })
      }
      return result
    } catch (err) {
      if (current()) {
        this.#cycleRuns.set(status, correlation)
        account.failure(err)
        const count = status.failure(err)
        if (count)
          log.log('warn', 'sync.cycle.failed', {
            provider,
            phase,
            durationMs: performance.now() - start,
            count,
            err,
          })
      }
      throw err
    }
  }

  startAccount(accountId: string, requestId?: RequestId): void {
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
      this.#startImap(row, previous, requestId)
      return
    }
    const { db, store, log } = this.#o
    let api: GmailApi
    try {
      const tokens = new AccessTokens(
        this.#o.oauthClient(),
        this.#o.sealer.open<GmailCredentials>(row.credentials),
      )
      api = this.#o.gmailApi
        ? this.#o.gmailApi(tokens)
        : new GmailHttpApi(tokens, fetch, {
            onRetry: ({ status, attempt, delayMs }) =>
              (this.#cycleLog.getStore() ?? log.with({ accountId })).log(
                'debug',
                'sync.gmail.request.retry',
                { status, attempt, durationMs: delayMs },
              ),
          })
    } catch (err) {
      this.#diagnostics.account(this.#diagnostics.sync, accountId).failure(err)
      log.log(
        'error',
        'sync.cycle.failed',
        {
          provider: 'gmail',
          phase: 'startup',
          durationMs: 0,
          count: 1,
          err,
        },
        { accountId, runId: newRunId(), requestId },
      )
      throw err
    }
    const controller = new AbortController()
    const signal = controller.signal
    const manual = new ManualPoll(signal)
    const stop = () => controller.abort()
    const isCurrent = () => !signal.aborted && this.#runners.get(accountId)?.stop === stop
    const sync = new GmailAccountSync(
      api,
      store,
      new DbAccountState(db, accountId, [row.address]),
      () => this.#cycleLog.getStore() ?? log.with({ accountId }),
      signal,
    )
    sync.onProgress = () => {
      if (isCurrent()) this.emit('change')
    }

    const fail = (error: unknown): boolean => {
      if (!isCurrent()) return true
      if (error instanceof OAuthError && error.needsReauth) {
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
      setAccountStatus(db, store, accountId, 'error', message)
      return false
    }

    const startupStatus = new OperationStatus()
    const historyStatus = new OperationStatus()
    const backfillStatus = new OperationStatus()
    const watchStatus = new OperationStatus()
    const backfill = async () => {
      while (!signal.aborted) {
        try {
          if (
            !(await this.#cycle(accountId, 'gmail', 'backfill', backfillStatus, isCurrent, () =>
              sync.backfillStep(),
            )) ||
            !isCurrent()
          )
            return
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
          log.log('info', 'sync.gmail.watch.finished', { ok: true }, { accountId })
          watchStatus.success()
          await sleep(Math.min(WATCH_RENEW_MS, Math.max(1_000, remaining - 60_000)), signal)
        } catch (error) {
          if (signal.aborted) return
          if (watchHealthy) {
            watchHealthy = false
            wake()
          }
          if (watchStatus.failure(error))
            log.log(
              'warn',
              'sync.gmail.watch.finished',
              {
                ok: false,
                err: error,
              },
              { accountId },
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
          const changes = await this.#cycle(
            accountId,
            'gmail',
            'history',
            historyStatus,
            isCurrent,
            async () => {
              if (Date.now() - lastLabels > this.#o.labelsEveryMs) {
                await sync.syncLabels()
                if (!isCurrent()) return 0
                lastLabels = Date.now()
              }
              return sync.incremental()
            },
            finishCheck?.requestId,
          )
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
          await this.#cycle(
            accountId,
            'gmail',
            'startup',
            startupStatus,
            isCurrent,
            () => sync.start(),
            requestId,
          )
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
      checkMail: (requestId) => manual.request(requestId),
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

  #startImap(
    row: NonNullable<ReturnType<typeof getAccountRow>>,
    previous?: Runner,
    requestId?: RequestId,
  ): void {
    const { db, store, log, sealer, imapPollMs } = this.#o
    const controller = new AbortController()
    const signal = controller.signal
    const manual = new ManualPoll(signal)
    let active: ImapAccountSync | undefined
    let useIdle = true
    const idleStatus = this.#diagnostics.account(this.#diagnostics.idle, row.id)
    const allStatus = new OperationStatus()
    const inboxStatus = new OperationStatus()
    const backfillStatus = new OperationStatus()
    const report = (failure: ImapSyncFailure, socketError?: Error) => {
      const details = imapErrorDetails(socketError ?? failure)
      const folder = failure.folder ? ` (${JSON.stringify(failure.folder).slice(1, -1)})` : ''
      const code = details.errorCode ? ` [${details.errorCode}]` : ''
      const message = `IMAP ${failure.phase}${folder}: ${failure.summary}${code}`
      const authExpired = failure.cause instanceof ImapAuthError
      setAccountStatus(db, store, row.id, authExpired ? 'auth_expired' : 'error', message)
      this.emit('change')
      return authExpired
    }

    const done = (async () => {
      await previous?.done
      if (signal.aborted) return
      let retryMs = 5_000
      let runId = newRunId()
      while (!signal.aborted) {
        const started = performance.now()
        const connectionLog = log.with({ accountId: row.id, runId, requestId })
        let connected = false
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
              if (!signal.aborted && client.usable) {
                connected = true
                const { recovered } = idleStatus.success()
                connectionLog.log('info', 'sync.imap.idle.connected', {
                  durationMs: performance.now() - started,
                  count: 1,
                  recovered,
                  mode: useIdle ? 'idle' : 'poll',
                })
              }
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
                  const status =
                    mode === 'all' ? allStatus : mode === 'inbox' ? inboxStatus : backfillStatus
                  backfilled = await this.#cycle(
                    row.id,
                    'imap',
                    mode,
                    status,
                    () => !signal.aborted,
                    () => sync.step(mode, useIdle ? inboxWindow : undefined),
                    finishCheck?.requestId,
                  )

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
          const err =
            failure instanceof ImapIdleFailure ? failure : (socketError ?? failure.cause ?? failure)
          const count = idleStatus.failure(err)
          if (count)
            connectionLog.log('warn', 'sync.imap.idle.reconnect', {
              durationMs: performance.now() - started,
              count,
              err,
              retryMs: failure.cause instanceof ImapAuthError ? 0 : retryMs,
              mode: useIdle ? 'idle' : 'poll',
            })
          if (!connected || phase === 'idle' || phase === 'poll') {
            this.#diagnostics.account(this.#diagnostics.sync, row.id).failure(err)
            if (count)
              connectionLog.log('warn', 'sync.cycle.failed', {
                provider: 'imap',
                phase: 'startup',
                durationMs: performance.now() - started,
                count,
                err,
              })
          }
          const authExpired = report(failure, socketError)
          const finish = finishCheck ?? manual.take()
          finish?.(false)
          if (authExpired) {
            controller.abort()
            return
          }
          if (connected) {
            // A later connection incident gets its own run. Early failed attempts keep this one.
            runId = newRunId()
            requestId = undefined
          }
          await manual.backoff(() => sleep(retryMs, signal))
          retryMs = Math.min(retryMs * 2, 5 * 60_000)
        }
      }
    })()
    this.#runners.set(row.id, {
      stop: () => controller.abort(),
      done,
      checkMail: (requestId) => manual.request(requestId),
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
