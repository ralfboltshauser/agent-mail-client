import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { hostname, tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { closeClientLogs } from '@amc/cli/triage'
import {
  fetchWithRequestId,
  isCorrelationId,
  newRequestId,
  RENDERER_LOG_CHANNEL,
  triageErrorClasses,
  triageFailureMessages,
} from '@amc/observability'
import { macLogDirectory } from '@amc/observability/node'
import type {
  ComposeDraft,
  ComposePatch,
  ComposeStart,
  DiscardDraftResult,
  OutboxItem,
  PairResponse,
  SendRequest,
  VersionedDraft,
} from '@amc/protocol'
import {
  AdoptScreenedDestination,
  BucketInput,
  BucketReviewInput,
  DRAFT_CHANGED,
  DRAFT_MISSING,
  type FilteredPage,
  FilterReviewInput,
  InboxFilterTarget,
  MAIL_SEARCH_PAGE_SIZE,
  type MailLink,
  MIRROR_CHANGED,
  MutationRequest,
  OwnerActionReasonInput,
  parseMailLink,
  SenderAvatarResolve,
  SenderDecision,
  SenderListQuery,
  THREAD_DRAFT_UNAVAILABLE,
  TriageExportInput,
  TriageHistoryQuery,
  TriageQueueQuery,
} from '@amc/protocol'
import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  type IpcMainInvokeEvent,
  ipcMain,
  Menu,
  MenuItem,
  Notification,
  nativeTheme,
  session,
  shell,
} from 'electron'
import type { AskAgentResult, SyncStatus, ThreadQuery, TriageStatus } from '../shared/api'
import { failureDetails, formatFailure, validFailure } from '../shared/failure'
import { feedbackAccelerator } from '../shared/feedback'
import { projectActionFailures } from './action-failures'
import { askAgent, pruneAgentSearches } from './ask-agent'
import { clearPairing, loadPairing, savePairing } from './auth'
import { AutoTriage } from './auto-triage'
import { desktopDiagnostics, installedCliVersion } from './diagnostics'
import { composeDraftPath, DraftRecoveryPending } from './draft-updates'
import { carryRequest, EngineClient, EngineError } from './engine'
import { registerFeedbackIpc } from './feedback-ipc'
import { Handoff, t3NavigationLink } from './handoff'
import { handleMailRefreshKey, mailboxViewMenu } from './mail-menu'
import { protectRemoteImageRequests } from './message-image-requests'
import {
  DEFAULT_NOTIFICATION_SETTINGS,
  NewMailNotifications,
  parseNotificationSettings,
} from './notifications'
import {
  configureDesktopLogs,
  type DesktopIpcChannel,
  desktopLogger,
  ipcError,
  mainLog,
  operationFailure,
  rendererLog,
  startupMarkerLog,
} from './observability'
import { OrganiseSync } from './organise'
import { createQuitHandler } from './quit'
import { loadRenderer } from './renderer-load'
import { limitRendererReports, ownMainFrame } from './renderer-reporting'
import { Replica } from './replica'
import { resolveSenderAvatars } from './sender-avatars'
import { SyncLoop } from './sync'
import { mcpLauncher, savedT3Url } from './t3'
import { localT3Launcher } from './t3-cli'
import { createTray } from './tray'
import { onLowBattery, runTriageProcess } from './triage-process'

let window: BrowserWindow | null = null
let rendererUrl: string | undefined
let replica: Replica | null = null
let engine: EngineClient | null = null
let sync: SyncLoop | null = null
let organise: OrganiseSync | null = null
let pausedStatus: SyncStatus | null = null
let tray: ReturnType<typeof createTray> | null = null
let changedTimer: NodeJS.Timeout | null = null
let draftRecovery: Promise<void> | null = null
let notificationSettings = DEFAULT_NOTIFICATION_SETTINGS
let notifications: NewMailNotifications | null = null
let threadNavigationReady = false
let pendingThreadId: string | null = null
let pendingMailLink: MailLink | null = null
let resolvingMailLink: MailLink | null = null
let askingAgent = false
let pendingSettings = false
let diagnosticsReady = false
let pendingDiagnostics = false
const notificationSettingsFile = () => join(app.getPath('userData'), 'notifications.json')
let feedback: ReturnType<typeof registerFeedbackIpc>
let handoff: Handoff
let triage: AutoTriage
const quittingTriage = new AbortController()
const dev = import.meta.env.DEV && !app.isPackaged
const checkMail = () => void sync?.checkMail()

const UNPAIRED: SyncStatus = {
  phase: 'unpaired',
  engineUrl: null,
  progress: null,
  lastSyncAt: null,
  error: null,
}

let startupStatus: SyncStatus = { ...UNPAIRED, phase: 'restoring-pairing' }
const pauseFile = () => join(app.getPath('userData'), 'sync-paused')
const triageOffFile = () => join(app.getPath('userData'), 'auto-triage-off')
const triageRunFile = () => join(app.getPath('userData'), 'triage-run.json')

function loadLastTriageRun(): TriageStatus['lastRun'] {
  try {
    const run = JSON.parse(readFileSync(triageRunFile(), 'utf8')) as TriageStatus['lastRun']
    if (!run || !Number.isFinite(run.at)) return null
    const error =
      typeof run.error === 'string'
        ? (Object.values(triageFailureMessages).find((message) => message === run.error) ??
          triageFailureMessages.unexpected)
        : null
    const failure =
      validFailure(run.failure) ||
      (run.failure?.kind === 'Run' &&
        isCorrelationId(run.failure.id) &&
        triageErrorClasses.some((errorClass) => errorClass === run.failure?.errorClass))
        ? run.failure
        : undefined
    const diagnostic =
      error && !failure ? operationFailure('triage-read', new Error(error)) : failure
    return { at: run.at, result: run.result, error, failure: diagnostic }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') operationFailure('triage-read', error)
    return null
  }
}

function setStartupStatus(status: SyncStatus) {
  startupStatus = status
  broadcast('amc:status', status)
}

function restoreSavedPairing() {
  mainLog.log('info', 'desktop.startup.pairing', { stage: 'reading' })
  const pairing = loadPairing()
  if (pairing.state === 'paired') {
    mainLog.log('info', 'desktop.startup.pairing', { stage: 'loaded' })
    connect(pairing.engineUrl, pairing.token)
  } else if (pairing.state === 'read-error') {
    mainLog.log('warn', 'desktop.startup.pairing', { stage: 'unreadable' })
    setStartupStatus({
      ...UNPAIRED,
      phase: 'pairing-read-error',
      engineUrl: pairing.engineUrl,
      failure: pairing.failure,
    })
  } else {
    setStartupStatus({ ...UNPAIRED, engineUrl: pairing.engineUrl })
  }
}

function broadcast(channel: string, payload?: unknown) {
  window?.webContents.send(channel, payload)
}

function openReplica(): Replica {
  if (replica) return replica
  try {
    mainLog.log('debug', 'desktop.operation.started', { stage: 'replica-open' })
    replica = new Replica(join(app.getPath('userData'), 'replica.db'))
    mainLog.log('debug', 'desktop.operation.finished', { stage: 'replica-open' })
    return replica
  } catch (error) {
    operationFailure('replica-open', error)
    throw error
  }
}

function refreshTray() {
  if (!tray) return
  const unread = engine ? openReplica().counts(null).inboxUnread : 0
  tray.refresh(unread, !!engine, !!pausedStatus)
  app.dock?.setBadge(unread ? unread.toLocaleString() : '')
}

function refreshMail() {
  broadcast('amc:changed')
  refreshTray()
}

function createOrganise(client: EngineClient, loop?: SyncLoop) {
  const worker = new OrganiseSync(
    openReplica().organise,
    client,
    () => loop?.pull() ?? Promise.resolve(),
  )
  worker.on('changed', refreshMail)
  return worker
}

function connect(engineUrl: string, token: string) {
  engine = new EngineClient(engineUrl, token)
  recoverHandoffs(engine)
  triage.connect((accountId, signal, recent, runId) =>
    runTriageProcess({ engineUrl, token }, accountId, recent, signal, quittingTriage.signal, runId),
  )
  if (existsSync(pauseFile())) {
    organise = createOrganise(engine)
    pausedStatus = { ...UNPAIRED, phase: 'paused', engineUrl }
    broadcast('amc:status', pausedStatus)
  } else {
    startSync(engine)
  }
  refreshTray()
}

function recoverHandoffs(client: EngineClient) {
  if (engine !== client) return
  void handoff.recover(client).catch(() => {
    setTimeout(() => recoverHandoffs(client), 10_000).unref()
  })
}

function startSync(client: EngineClient) {
  pausedStatus = null
  const updates = openReplica().draftUpdates
  const recovering = updates.flush(client)
  draftRecovery = recovering
  const loop = new SyncLoop(client, openReplica())
  if (notifications) loop.on('newMail', (messages) => notifications?.add(messages))
  sync = loop
  organise = createOrganise(client, loop)
  broadcast('amc:status', loop.status)
  let replayOnLive = true
  let reportedPhase = loop.status.phase
  loop.on('status', (status) => {
    if (sync !== loop) return
    if (status.phase === 'unpaired') {
      mainLog.log('warn', 'desktop.startup.pairing', { stage: 'rejected' })
      stopSync()
      engine = null
      organise = null
      triage.connect(null)
      setStartupStatus(status)
      refreshTray()
      return
    }
    if (replayOnLive && status.phase !== reportedPhase) {
      const log = status.phase === 'live' ? startupMarkerLog : mainLog
      log.log('info', 'desktop.sync.phase', { phase: status.phase })
      reportedPhase = status.phase
    }
    broadcast('amc:status', status)
    triage.setAvailable(status.phase === 'live')
    if (status.phase === 'live' || status.phase === 'error') openPendingMailLink()
    if (status.phase === 'live' && replayOnLive) {
      replayOnLive = false
      draftRecovery = recovering.then(() => {
        if (sync === loop) return updates.flush(client)
      })
    }
  })
  loop.on('arrivals', (threads) => triage.arrivals(threads))
  loop.on('changed', () => {
    // Coalesce bursts (backfill pages) into one UI refresh per 120 ms.
    if (changedTimer) return
    changedTimer = setTimeout(() => {
      changedTimer = null
      refreshMail()
    }, 120)
  })
  loop.start()
  organise.start()
}

function stopSync() {
  const stoppingTriage = triage?.stop()
  sync?.stop()
  notifications?.clear()
  sync = null
  organise?.stop()
  return stoppingTriage
}

function toggleSync() {
  if (!engine) return
  try {
    if (sync) writeFileSync(pauseFile(), '')
    else rmSync(pauseFile(), { force: true })
  } catch (error) {
    operationFailure('sync-preference', error)
    return
  }
  if (sync) {
    pausedStatus = { ...sync.status, phase: 'paused', progress: null, error: null }
    stopSync()
    broadcast('amc:status', pausedStatus)
  } else {
    startSync(engine)
  }
  refreshTray()
}

function requireEngine(): EngineClient {
  if (!engine) throw new Error('Not paired with an Engine')
  return engine
}

const safeEngineHints = new Set([
  DRAFT_CHANGED,
  DRAFT_MISSING,
  THREAD_DRAFT_UNAVAILABLE,
  MIRROR_CHANGED,
  'The recipients, subject or attachments may have changed. Reopen the draft to review them.',
  'Triage queue changed. Start a fresh snapshot.',
  'Owner action unavailable',
  'The sender rule changed while saving the decision. Choose Accept or Block again.',
])

class ReviewRejection extends Error {
  readonly original: EngineError

  constructor(original: EngineError) {
    super('Review rejected')
    this.original = original
  }
}

function handle<Args extends unknown[], Result>(
  channel: DesktopIpcChannel,
  listener: (event: IpcMainInvokeEvent, ...args: Args) => Result,
) {
  ipcMain.handle(channel, async (event, ...args: Args) => {
    if (!ownMainFrame(event, window?.webContents, rendererUrl)) throw new Error('IPC denied')
    try {
      return projectActionFailures(channel, await listener(event, ...args))
    } catch (error) {
      if (error instanceof ReviewRejection) {
        const hint = safeEngineHints.has(error.original.message)
          ? error.original.message
          : 'The Engine refused this change.'
        throw ipcError(channel, error.original, `Review rejected: ${hint}`)
      }
      const hint =
        error instanceof DraftRecoveryPending ||
        (error instanceof EngineError && safeEngineHints.has(error.message))
          ? error.message
          : undefined
      throw ipcError(channel, error, hint)
    }
  })
}

function registerIpc(logDirectory: string) {
  let copying: Promise<void> | undefined
  handle('amc:copyDiagnostics', () => {
    copying ??= desktopDiagnostics({
      desktopVersion: app.getVersion(),
      readCliVersion: installedCliVersion,
      directory: logDirectory,
      engine,
      sync: sync?.status ?? pausedStatus ?? startupStatus,
    })
      .then((snapshot) => clipboard.writeText(snapshot))
      .finally(() => {
        copying = undefined
      })
    return copying
  })
  ipcMain.on('amc:diagnosticsReady', (event) => {
    if (!ownMainFrame(event, window?.webContents, rendererUrl)) return
    diagnosticsReady = true
    openPendingDiagnostics()
  })
  handle('amc:notificationSettings', () => notificationSettings)
  handle('amc:saveNotificationSettings', (_event, input: unknown) => {
    const settings = parseNotificationSettings(input)
    const path = notificationSettingsFile()
    writeFileSync(`${path}.tmp`, JSON.stringify(settings), { mode: 0o600 })
    renameSync(`${path}.tmp`, path)
    notificationSettings = settings
    if (!settings.enabled) notifications?.clear()
  })
  ipcMain.on('amc:threadNavigationReady', (event) => {
    if (!ownMainFrame(event, window?.webContents, rendererUrl)) return
    threadNavigationReady = true
    openPendingThread()
    openPendingMailLink()
    openPendingSettings()
  })
  handle('amc:triageStatus', () => triage.status)
  handle('amc:setAutoTriage', (_e, enabled: unknown) => {
    if (typeof enabled !== 'boolean') throw new Error('Invalid auto-triage setting')
    if (enabled) rmSync(triageOffFile(), { force: true })
    else writeFileSync(triageOffFile(), '')
    triage.setEnabled(enabled)
  })
  handle('amc:triageCounts', (_e, accountId: unknown) => {
    if (accountId !== null && typeof accountId !== 'string') throw new Error('Invalid Account')
    return openReplica().triageCounts(accountId)
  })
  handle('amc:triageNow', async (_e, accountId: unknown, scope: unknown) => {
    if (accountId !== null && typeof accountId !== 'string') throw new Error('Invalid Account')
    if (scope === 'recent') return triage.now(accountId)
    if (scope !== 'account') throw new Error('Invalid triage scope')
    if (!window || sync?.status.phase !== 'live' || triage.status.running) return
    const connection = engine
    const account = openReplica().triageAccount(accountId, undefined, 'older')
    if (!account) return
    const address = openReplica()
      .accounts()
      .find(({ id }) => id === account)?.address
    const { response } = await dialog.showMessageBox(window, {
      type: 'question',
      title: 'Triage older mail?',
      message: 'Triage older mail?',
      detail: `This runs one batch across ${address ?? 'the selected Account'}’s untriaged Inbox, including recent and older mail.`,
      buttons: ['Cancel', 'Triage mail'],
      defaultId: 0,
      cancelId: 0,
    })
    if (response === 1 && engine === connection) await triage.now(account, false)
  })
  handle('amc:pair', (_e, engineUrl: string, code: string) => pair(engineUrl, code))
  handle('amc:retrySavedPairing', () => {
    if (startupStatus.phase === 'pairing-read-error') return restoreSavedPairing()
  })
  handle('amc:unpair', () => {
    stopSync()
    organise = null
    pausedStatus = null
    engine = null
    pendingThreadId = null
    pendingMailLink = null
    triage.connect(null)
    clearPairing()
    openReplica().clear()
    openReplica().organise.clear()
    openReplica().draftUpdates.clear()
    draftRecovery = null
    setStartupStatus(UNPAIRED)
    refreshTray()
  })
  const queryString = (query: Record<string, string | number | undefined>) => {
    const params = new URLSearchParams()
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined) params.set(key, String(value))
    }
    return params.toString()
  }
  const reportReviewRejection = (error: unknown): never => {
    if (error instanceof EngineError && [400, 403, 404, 409, 422].includes(error.status))
      throw new ReviewRejection(error)
    throw error
  }
  handle('amc:listSenders', (_event, query: unknown) =>
    requireEngine().get(`/v1/senders?${queryString(SenderListQuery.parse(query))}`),
  )
  handle('amc:decideSender', (_event, input: unknown) =>
    requireEngine()
      .request('/v1/senders/decisions', {
        method: 'POST',
        body: SenderDecision.parse(input),
        signal: AbortSignal.timeout(10_000),
      })
      .catch(reportReviewRejection),
  )
  const submitFilter = (input: unknown) =>
    requireEngine()
      .request('/v1/filtered/decisions', {
        method: 'POST',
        body: FilterReviewInput.parse(input),
        signal: AbortSignal.timeout(10_000),
      })
      .catch(reportReviewRejection)
  handle('amc:reviewFilter', (_event, input: unknown) => submitFilter(input))
  handle('amc:filterThread', async (_event, threadId: string, clientActionId: string) => {
    const engine = requireEngine()
    const localIds = openReplica().inboxFilterMessageIds(threadId)
    if (!localIds.length) throw new Error('There are no eligible Inbox messages to filter')
    const reply = await engine
      .get<unknown>(`/v1/filtered/inbox-target?${queryString({ threadId })}`, {
        signal: AbortSignal.timeout(10_000),
      })
      .catch((error: unknown) => {
        if (error instanceof EngineError && error.status === 404 && error.code === 'not_found')
          throw new Error('Filter out from the Thread list and reader requires an Engine update.')
        throw error
      })
    const target = InboxFilterTarget.parse(reply)
    if (requireEngine() !== engine) throw new Error('The Engine pairing changed')
    if (
      target.messageIds.length !== localIds.length ||
      localIds.some((id, index) => id !== target.messageIds[index])
    ) {
      sync?.pullInBackground()
      throw new Error('The Inbox messages changed. Refresh the Thread and try again.')
    }
    return submitFilter({
      threadId,
      clientActionId,
      expectedRevision: target.revision,
      expectedInboxTarget: target.digest,
      decision: 'filter.filtered',
      source: 'thread-action',
    })
  })
  handle('amc:restoreFiltered', async (_event, threadId: string, clientActionId: string) => {
    const engine = requireEngine()
    const params = queryString({ threadId, limit: 1 })
    const page = await engine.get<FilteredPage>(`/v1/filtered?${params}`, {
      signal: AbortSignal.timeout(10_000),
    })
    const thread = page.threads[0]
    if (!thread || requireEngine() !== engine) throw new Error('Thread is unavailable in Filtered')
    return submitFilter({
      threadId,
      clientActionId,
      expectedRevision: thread.revision,
      decision: 'filter.keep',
    })
  })
  handle('amc:editOwnerReason', (_event, actionId: string, input: unknown) =>
    requireEngine().request(`/v1/owner-actions/${encodeURIComponent(actionId)}/reason`, {
      method: 'PUT',
      body: OwnerActionReasonInput.parse(input),
      signal: AbortSignal.timeout(10_000),
    }),
  )
  handle('amc:adoptScreenedDestination', (_event, input: unknown) => {
    const { destination, ...body } = AdoptScreenedDestination.parse(input)
    return requireEngine().request(
      destination === 'filtered'
        ? '/v1/filtered/destination/adopt'
        : '/v1/senders/destination/adopt',
      {
        method: 'POST',
        body,
      },
    )
  })
  handle('amc:ownerAction', (_event, id: string, includeReason?: boolean) =>
    requireEngine().get(
      `/v1/owner-actions/${encodeURIComponent(id)}${includeReason ? '?includeReason=1' : ''}`,
      {
        signal: AbortSignal.timeout(10_000),
      },
    ),
  )
  handle('amc:undoOwnerAction', (_event, id: string) =>
    requireEngine().request(`/v1/owner-actions/${encodeURIComponent(id)}/undo`, {
      method: 'POST',
      signal: AbortSignal.timeout(10_000),
    }),
  )
  handle('amc:triageHistory', (_event, query: unknown) => {
    const params = queryString(TriageHistoryQuery.parse(query))
    return requireEngine().get(`/v1/triage/events?${params}`, {
      signal: AbortSignal.timeout(10_000),
    })
  })
  handle('amc:forgetTriageDecision', (_event, id: string) =>
    requireEngine().request(`/v1/triage/events/${encodeURIComponent(id)}`, {
      method: 'DELETE',
      redirect: 'error',
      signal: AbortSignal.timeout(10_000),
    }),
  )
  handle('amc:exportTriageHistory', async (_event, input: unknown) => {
    const engine = requireEngine()
    const body = TriageExportInput.parse(input)
    const { filePath } = await dialog.showSaveDialog({
      title: 'Export triage history',
      defaultPath: 'amc-owner-preferences.jsonl',
    })
    if (!filePath) return false
    if (requireEngine() !== engine) throw new Error('The Engine pairing changed')
    const response = await engine.response('/v1/triage/events/export', {
      method: 'POST',
      body,
      redirect: 'error',
      signal: AbortSignal.timeout(60_000),
    })
    if (!response.headers.get('Content-Type')?.startsWith('application/x-ndjson'))
      throw new Error('Engine did not return an owner-preferences export')
    await writeFile(filePath, Buffer.from(await response.arrayBuffer()), {
      flag: 'wx',
      mode: 0o600,
    })
    return true
  })
  handle('amc:triageQueue', (_event, query: unknown) => {
    return requireEngine().get(`/v1/triage/queue?${queryString(TriageQueueQuery.parse(query))}`, {
      signal: AbortSignal.timeout(10_000),
    })
  })
  handle('amc:reviewPairing', () => requireEngine().pairingScope)
  handle('amc:reviewBucket', async (_event, input: unknown) => {
    const loop = sync
    const result = await requireEngine()
      .request('/v1/bucket', {
        method: 'PUT',
        body: BucketReviewInput.parse(input),
        signal: AbortSignal.timeout(10_000),
      })
      .catch(reportReviewRejection)
    loop?.pullInBackground()
    return result
  })
  handle('amc:reviewOrganiseStatus', (_event, id: string) => {
    requireEngine()
    return openReplica().organise.reviewStatus(id)
  })
  handle('amc:reviewOrganise', (_event, input: unknown, id: unknown, messageId?: string) => {
    if (!organise) throw new Error('Pair with the Engine first')
    const parsed = MutationRequest.parse({ id, action: input })
    const action = parsed.action
    if (action.kind !== 'archive' && action.kind !== 'snooze' && action.kind !== 'undo')
      throw new Error('Invalid triage Organise action')
    const queued = organise.enqueue(action, (sync?.status ?? pausedStatus)?.snoozeEnabled, {
      id: parsed.id,
      messageId,
    })
    refreshMail()
    if (sync) void organise.flush()
    return queued
  })
  handle('amc:resolveSenderAvatars', async (_event, input: unknown, known: unknown) => {
    const connection = requireEngine()
    const result = await resolveSenderAvatars(connection, SenderAvatarResolve.parse(input), known)
    return connection === engine ? result : { rows: [] }
  })
  handle('amc:setBucket', async (_event, input: unknown) => {
    const body = BucketInput.parse(input)
    const loop = sync
    if (!loop) throw new Error('Resume sync to move Threads between Buckets')
    await requireEngine().request('/v1/bucket', {
      method: 'PUT',
      body,
      signal: AbortSignal.timeout(10_000),
    })
    loop.pullInBackground() // The normal sync loop retries if this pull fails.
  })
  handle('amc:organise', (_event, input: unknown) => {
    if (!organise) throw new Error('Pair with the Engine first')
    const id = organise.enqueue(input, (sync?.status ?? pausedStatus)?.snoozeEnabled)
    refreshMail()
    if (sync) void organise.flush()
    return id
  })
  handle('amc:organiseErrors', () => openReplica().organise.errors())
  registerReadIpc()
  registerComposeIpc()
}

async function pair(engineUrl: string, code: string) {
  const requestId = newRequestId()
  mainLog.log('info', 'desktop.operation.started', { stage: 'pairing-request' }, { requestId })
  try {
    const url = new URL(engineUrl).origin
    const res = await fetchWithRequestId(
      new URL('/v1/auth/pair', url),
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code, deviceName: `${hostname()} (desktop)` }),
      },
      requestId,
    )
    if (!res.ok) throw new EngineError(res.status, 'error', 'Pairing failed')
    const body = (await res.json()) as Partial<PairResponse>
    if (typeof body?.token !== 'string' || !body.token || body.kind !== 'desktop') {
      throw new TypeError('Invalid desktop pairing response')
    }
    const previousUrl = engine?.baseUrl ?? startupStatus.engineUrl
    savePairing(url, body.token)
    stopSync()
    if (previousUrl !== url) {
      pendingThreadId = null
      if (previousUrl) pendingMailLink = null
      const db = openReplica()
      db.transaction(() => {
        db.clear()
        db.organise.clear()
        db.draftUpdates.clear()
      })
      broadcast('amc:changed')
    }
    connect(url, body.token)
    mainLog.log('info', 'desktop.operation.finished', { stage: 'pairing-request' }, { requestId })
  } catch (error) {
    operationFailure('pairing-request', error, failureDetails(error, requestId, 'Request'))
    throw error
  }
}

function registerComposeIpc() {
  handoff = new Handoff(openReplica().db)
  handle('amc:t3Setup', async () => ({
    kind: (await localT3Launcher()) ? 'cli' : 'mcp',
    address: savedT3Url(),
  }))
  const launcher = async (address: string | null) => {
    if (address !== null) return mcpLauncher(address)
    const local = await localT3Launcher()
    if (!local) throw new Error('AMC could not find the local T3 CLI.')
    return local
  }
  handle('amc:t3Projects', async (_e, address: string | null) =>
    (await launcher(address)).projects(),
  )
  handle('amc:handoff', async (_e, address: string | null, projectId: string, threadId: string) => {
    await draftRecovery
    try {
      const { draft, thread } = await handoff.launch(
        requireEngine(),
        projectId,
        threadId,
        await launcher(address),
      )
      const link = thread.link && t3NavigationLink(thread.link)
      if (link)
        void shell.openExternal(link).catch((error) => operationFailure('external-link', error))
      return draft
    } finally {
      broadcast('amc:changed')
    }
  })
  handle(
    'amc:cancelHandoff',
    async (_e, address: string | null, projectId: string, threadId: string) => {
      await handoff.cancel(requireEngine(), projectId, threadId, await launcher(address))
      broadcast('amc:changed')
    },
  )
  handle('amc:activeHandoff', (_e, threadId: string) => handoff.active(requireEngine(), threadId))
  handle('amc:endHandoff', async (_e, id: string) => {
    await handoff.end(requireEngine(), id)
    broadcast('amc:changed')
  })
  const compose = '/v1/compose'
  const draftPath = composeDraftPath
  const signaturePath = (id: string) => `${compose}/signature/${encodeURIComponent(id)}`
  handle('amc:startCompose', (_e, body: ComposeStart) =>
    requireEngine().request(`${compose}/drafts`, { method: 'POST', body }),
  )
  handle(
    'amc:composeDrafts',
    async () =>
      (await requireEngine().get<{ drafts: VersionedDraft[] }>(`${compose}/drafts`)).drafts,
  )
  handle('amc:composeDraft', async (_e, id: string) => {
    await draftRecovery
    return requireEngine().get(draftPath(id), { signal: AbortSignal.timeout(15_000) })
  })
  handle('amc:composeDraftByMessage', async (_e, messageId: string, imapRevision?: string) => {
    const client = requireEngine()
    const recovering = draftRecovery
    await recovering
    if (engine !== client) throw new Error('The Engine pairing changed')
    const path = `${compose}/drafts/by-message/${encodeURIComponent(messageId)}`
    const query = imapRevision ? `?${new URLSearchParams({ imapRevision })}` : ''
    const load = () =>
      client.get<ComposeDraft>(path + query, { signal: AbortSignal.timeout(15_000) })
    const draft = await load()
    const recoveryChanged = recovering !== draftRecovery
    if (recoveryChanged) await draftRecovery
    if (engine !== client) throw new Error('The Engine pairing changed')
    const replayed = await openReplica().draftUpdates.recover(client, draft.id)
    const opened = recoveryChanged || replayed ? await load() : draft
    if (engine !== client || opened.id !== draft.id) throw new Error('The draft changed')
    return opened
  })
  handle('amc:discardDraft', async (_e, id: string, revision: number) => {
    const client = requireEngine()
    // Older Engines reject this route instead of discarding without a revision check.
    const result = await client.request<DiscardDraftResult>(`${draftPath(id)}/discard`, {
      method: 'POST',
      body: { revision },
    })
    if (engine === client) {
      openReplica().draftUpdates.discard(id)
      sync?.pullInBackground() // Normal sync retries if this pull fails.
    }
    return result
  })
  ipcMain.on('amc:stageComposeBody', (event, id: string, patch: ComposePatch) => {
    if (!ownMainFrame(event, window?.webContents, rendererUrl)) {
      event.returnValue = 'IPC denied'
      return
    }
    try {
      openReplica().draftUpdates.stage(id, patch)
      event.returnValue = null
    } catch (error) {
      event.returnValue = ipcError('amc:stageComposeBody', error).message
    }
  })
  handle('amc:saveCompose', async (_e, id: string, body: ComposePatch) => {
    const saved = await requireEngine().request<ComposeDraft>(draftPath(id), {
      method: 'PUT',
      body,
      signal: AbortSignal.timeout(15_000),
    })
    openReplica().draftUpdates.acknowledge(id, body)
    return saved
  })
  handle(
    'amc:addComposeAttachment',
    (_e, id: string, filename: string, mimeType: string, bytes: Uint8Array, inline?: boolean) =>
      requireEngine().request(`${draftPath(id)}/attachments`, {
        method: 'POST',
        body: { filename, mimeType, inline, content: Buffer.from(bytes).toString('base64') },
      }),
  )
  handle('amc:composeImage', (_e, id: string, contentId: string) =>
    requireEngine().get(`${draftPath(id)}/inline?cid=${encodeURIComponent(contentId)}`),
  )
  handle('amc:sendDraft', async (_e, body: SendRequest) => {
    const item = await requireEngine().request<OutboxItem>(`${compose}/outbox`, {
      method: 'POST',
      body,
    })
    if (body.edits) {
      openReplica().draftUpdates.acknowledge(body.draftId, {
        ...body.edits,
        baseRevision: body.revision,
      })
    }
    return item
  })
  handle('amc:outbox', async () => {
    const result = await requireEngine().get<{ items: OutboxItem[] }>(`${compose}/outbox`)
    return carryRequest(result.items, result)
  })
  handle('amc:resolveSend', (_e, id: string, action: 'check' | 'reopen') =>
    requireEngine().request(`${compose}/outbox/${encodeURIComponent(id)}/resolve`, {
      method: 'POST',
      body: { action },
    }),
  )
  handle('amc:cancelSend', async (_e, id: string) => {
    await requireEngine().request(`${compose}/outbox/${encodeURIComponent(id)}/cancel`, {
      method: 'POST',
    })
  })
  handle('amc:signature', (_e, id: string) => requireEngine().get(signaturePath(id)))
  handle('amc:saveSignature', (_e, id: string, signature: string) =>
    requireEngine().request(signaturePath(id), { method: 'PUT', body: { signature } }),
  )
  handle('amc:sendSettings', () => requireEngine().get(`${compose}/settings`))
  handle('amc:saveSendSettings', (_e, undoSendSeconds: number) =>
    requireEngine().request(`${compose}/settings`, { method: 'PUT', body: { undoSendSeconds } }),
  )
}

function registerReadIpc() {
  handle('amc:agentActivity', (_e, before: unknown) => {
    if (before === undefined) return requireEngine().get('/v1/agent/log')
    if (typeof before !== 'number' || !Number.isSafeInteger(before) || before <= 0)
      throw new Error('Invalid activity cursor')
    return requireEngine().get(`/v1/agent/log?before=${before}`)
  })
  handle('amc:undoAgentAction', async (_e, id: unknown) => {
    if (typeof id !== 'string') throw new Error('Invalid action ID')
    await requireEngine().request(`/v1/agent/log/${encodeURIComponent(id)}/undo`, {
      method: 'POST',
    })
    void sync?.pull()
  })

  handle('amc:status', () => sync?.status ?? pausedStatus ?? startupStatus)
  handle('amc:syncNow', () => sync?.pull())

  handle('amc:accounts', () => openReplica().accounts())
  handle('amc:labels', (_e, accountId: string | null) => openReplica().labels(accountId))
  handle('amc:counts', (_e, accountId: string | null) => openReplica().counts(accountId))
  handle('amc:threads', (_e, query: ThreadQuery) => openReplica().threads(query))
  handle('amc:thread', (_e, id: string) => openReplica().thread(id))
  handle('amc:summaries', (_e, ids: string[]) => openReplica().summaries(ids))
  handle('amc:filter', (_e, text: string, accountId: string | null) =>
    openReplica().filter(text, accountId),
  )
  handle('amc:search', async (_e, text: string, accountId: string | null, offset = 0) => {
    const params = new URLSearchParams({
      q: text,
      limit: String(MAIL_SEARCH_PAGE_SIZE),
      ...(offset ? { offset: String(offset) } : {}),
      ...(accountId ? { accountId } : {}),
    })
    return (await requireEngine().get<{ hits: unknown[] }>(`/v1/search?${params}`)).hits
  })
  handle(
    'amc:askAgent',
    async (_e, input: unknown, accountId: unknown): Promise<AskAgentResult> => {
      if (typeof input !== 'string' || !input.trim() || input.length > 4000)
        return { opened: false, reason: 'Enter a question of up to 4,000 characters.' }
      if (
        accountId !== null &&
        (typeof accountId !== 'string' ||
          !openReplica()
            .accounts()
            .some(({ id }) => id === accountId))
      )
        return { opened: false, reason: 'That mail account is unavailable.' }
      const client = engine
      if (!client) return { opened: false, reason: 'Connect AMC to its Engine first.' }
      if (askingAgent) return { opened: false, reason: 'AMC is already opening a T3 thread.' }
      askingAgent = true
      try {
        return await askAgent(
          client,
          app.getPath('userData'),
          input.trim(),
          accountId,
          () => engine === client,
          (url) => shell.openExternal(url),
        )
      } finally {
        askingAgent = false
      }
    },
  )
  handle('amc:contacts', async (_e, text: string) => {
    return (
      await requireEngine().get<{ contacts: unknown[] }>(
        `/v1/contacts?q=${encodeURIComponent(text)}`,
      )
    ).contacts
  })
  handle('amc:messageText', (_e, messageId: string) => openReplica().messageText(messageId))
  // Cap speculative IPC and renderer cache use. The selected reader can load the full body.
  handle('amc:cachedMessageHtml', (_e, messageId: string) =>
    openReplica().html(messageId, 256 * 1024),
  )
  handle('amc:messageHtml', async (_e, messageId: string) => {
    const local = openReplica()
    const cached = local.html(messageId)
    if (cached !== null) return cached
    const source = local.htmlSource(messageId)
    if (source === undefined) return null
    const client = requireEngine()
    try {
      const { html } = await client.get<{ html: string }>(
        `/v1/messages/${encodeURIComponent(messageId)}/html`,
      )
      if (engine !== client || replica !== local || local.htmlSource(messageId) !== source)
        return null
      local.putHtml(messageId, html)
      return html
    } catch (error) {
      if (error instanceof EngineError && error.status === 404) return null
      throw error
    }
  })
  handle('amc:inlineAttachment', async (_e, attachmentId: string) => {
    const data = await requireEngine().bytes(`/v1/attachments/${encodeURIComponent(attachmentId)}`)
    return data.toString('base64')
  })
  handle('amc:openAttachment', async (_e, attachmentId: string, filename: string) => {
    const data = await requireEngine().bytes(`/v1/attachments/${encodeURIComponent(attachmentId)}`)
    const dir = join(tmpdir(), 'amc-attachments', attachmentId.replace(/[^\w.-]/g, '_'))
    mkdirSync(dir, { recursive: true })
    const path = join(dir, filename.replace(/[/\\]/g, '_') || 'attachment')
    writeFileSync(path, data)
    if (await shell.openPath(path)) throw new Error('Could not open attachment')
  })
  handle('amc:openExternal', async (_e, url: string) => {
    const parsed = new URL(url)
    if (!['http:', 'https:', 'mailto:'].includes(parsed.protocol))
      throw new Error('Refusing to open that link')
    await shell.openExternal(parsed.toString())
  })
}

async function flushDrafts() {
  await replica?.draftUpdates.flush(engine)
}

function openPendingThread() {
  if (!threadNavigationReady || !pendingThreadId) return
  const [thread] = openReplica().summaries([pendingThreadId])
  pendingThreadId = null
  if (thread) broadcast('amc:openThread', thread)
}

function receiveMailLink(link: MailLink) {
  pendingThreadId = null
  pendingMailLink = link
  if (app.isReady() && feedback) {
    openWindow()
    openPendingMailLink()
  }
}

function openPendingMailLink() {
  const target = pendingMailLink
  const client = engine
  if (!target || !client || !threadNavigationReady || resolvingMailLink === target) return
  if (target.kind === 'search') {
    if (
      target.accountId &&
      !openReplica()
        .accounts()
        .some(({ id }) => id === target.accountId)
    ) {
      if (sync?.status.phase === 'connecting' || sync?.status.phase === 'bootstrapping') return
      pendingMailLink = null
      if (window)
        void dialog
          .showMessageBox(window, {
            message: 'This search’s account is unavailable in AMC.',
            detail: 'Check that AMC is connected to the same Engine and has synced the account.',
          })
          .catch((error) => operationFailure('mail-link', error))
      return
    }
    pendingMailLink = null
    broadcast('amc:openMailSearch', target)
    return
  }

  const [cached] = openReplica().summaries([target.threadId])
  if (cached) {
    pendingMailLink = null
    broadcast('amc:openThread', cached)
    return
  }
  const loop = sync
  if (loop?.status.phase === 'connecting' || loop?.status.phase === 'bootstrapping') return
  resolvingMailLink = target
  void (async () => {
    try {
      if (loop?.status.phase === 'live') await loop.pull()
    } catch (error) {
      operationFailure('mail-link', error)
    } finally {
      if (resolvingMailLink === target) resolvingMailLink = null
    }
    if (target !== pendingMailLink || client !== engine || !threadNavigationReady) return
    pendingMailLink = null
    const [thread] = openReplica().summaries([target.threadId])
    if (thread) broadcast('amc:openThread', thread)
    else if (window) {
      await dialog.showMessageBox(window, {
        message: 'This thread is unavailable in AMC.',
        detail: 'Check that AMC is connected to the same Engine and has synced the thread.',
      })
    }
  })().catch((error) => operationFailure('mail-link', error))
}

function createWindow() {
  window = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 900,
    minHeight: 560,
    show: false,
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 16, y: 16 },
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#1b1b1f' : '#fdfdfd',
    webPreferences: {
      preload: join(import.meta.dirname, '../preload/index.cjs'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: true,
      devTools: dev,
    },
  })
  const current = window
  threadNavigationReady = false
  diagnosticsReady = false
  current.webContents.on('before-input-event', (event, input) => {
    handleMailRefreshKey(event, input, checkMail)
  })
  current.webContents.on('did-start-navigation', ({ isMainFrame, isSameDocument }) => {
    if (isMainFrame && !isSameDocument) {
      threadNavigationReady = false
      diagnosticsReady = false
      feedback.reset()
    }
  })
  current.webContents.on('render-process-gone', () => {
    feedback.reset()
    threadNavigationReady = false
    diagnosticsReady = false
  })
  current.once('ready-to-show', () => current.show())
  // Never let the app window navigate away or open windows; links go to the browser.
  current.webContents.setWindowOpenHandler(({ url }) => {
    if (/^(https?|mailto):/.test(url)) {
      void shell.openExternal(url).catch((error) => operationFailure('external-link', error))
    }
    return { action: 'deny' }
  })
  current.webContents.on('will-navigate', (event, url) => {
    if (url !== current.webContents.getURL()) event.preventDefault()
  })
  current.webContents.on('will-frame-navigate', (event) => {
    if (!event.isMainFrame && event.url !== 'about:srcdoc') event.preventDefault()
  })
  const devUrl = app.isPackaged ? undefined : process.env.ELECTRON_RENDERER_URL
  const entry = join(import.meta.dirname, '../renderer/index.html')
  rendererUrl = devUrl ? new URL(devUrl).href : pathToFileURL(entry).href
  loadRenderer(
    current,
    () => (devUrl ? current.loadURL(devUrl) : current.loadFile(entry)),
    async (reload, details) => {
      current.show()
      const { response } = await dialog.showMessageBox(current, {
        type: 'error',
        message: 'AMC couldn’t load.',
        detail: formatFailure(details),
        buttons: ['Reload', 'Close'],
        cancelId: 1,
      })
      if (current.isDestroyed()) return
      if (response === 0) setImmediate(reload)
      else current.close()
    },
  )
  let closing = false
  let flushed = false
  current.on('close', (event) => {
    if (flushed) return
    event.preventDefault()
    if (closing) return
    closing = true
    void flushDrafts().finally(() => {
      flushed = true
      if (!current.isDestroyed()) current.close()
    })
  })
  window.on('closed', () => {
    feedback.reset()
    window = null
  })
}

function openWindow() {
  if (process.platform === 'darwin') app.focus({ steal: true })
  if (!window) {
    createWindow()
    return
  }
  if (window.isMinimized()) window.restore()
  window.show()
  window.focus()
}

function openPendingSettings() {
  // The workspace subscribes to Settings before it signals thread navigation readiness.
  if (!threadNavigationReady || !pendingSettings) return
  pendingSettings = false
  window?.webContents.send('amc:openSettings')
}

function openSettings() {
  pendingSettings = true
  if (!window?.isFocused()) openWindow()
  openPendingSettings()
}

function openPendingDiagnostics() {
  if (!diagnosticsReady || !pendingDiagnostics) return
  pendingDiagnostics = false
  broadcast('amc:copyDiagnostics')
}

function copyDiagnosticsFromMenu() {
  pendingDiagnostics = true
  if (!window?.isFocused()) openWindow()
  openPendingDiagnostics()
}

function buildMenu() {
  const menu = Menu.buildFromTemplate([
    { role: 'appMenu', id: 'app-menu' },
    { role: 'editMenu' },
    mailboxViewMenu(dev, checkMail),
    { role: 'windowMenu' },
    {
      role: 'help',
      submenu: [
        {
          id: 'send-feedback',
          label: 'Send Feedback…',
          accelerator: feedbackAccelerator,
          click: feedback.open,
        },
        { label: 'Copy Diagnostics', click: copyDiagnosticsFromMenu },
      ],
    },
  ])
  if (process.platform === 'darwin') {
    const appMenu = menu.getMenuItemById('app-menu')?.submenu
    appMenu?.insert(
      1,
      new MenuItem({ label: 'Settings…', accelerator: 'CmdOrCtrl+,', click: openSettings }),
    )
  }
  Menu.setApplicationMenu(menu)
}

app.setName('AMC')
const customProfile = app.commandLine.getSwitchValue('user-data-dir')
const defaultProfile = join(app.getPath('appData'), '@amc', 'desktop')
const profile =
  customProfile || (app.isPackaged ? defaultProfile : join(app.getAppPath(), '.amc-dev'))
mkdirSync(profile, { mode: 0o700, recursive: true })
app.setPath('userData', profile)
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  const logDirectory = profile === defaultProfile ? macLogDirectory() : join(profile, 'logs')
  const settings = configureDesktopLogs(logDirectory, profile, import.meta.url)
  const report = limitRendererReports(() => rendererLog)
  ipcMain.handle(RENDERER_LOG_CHANNEL, (event, payload: unknown) => {
    if (ownMainFrame(event, window?.webContents, rendererUrl)) report(payload)
  })
  handle('amc:logSettings', settings.read)
  handle('amc:setDebugLogging', (_event, enabled: unknown) => settings.write(enabled))
  const linkFromArgs = (args: string[]) =>
    args.map(parseMailLink).find((target): target is MailLink => target !== null)
  pendingMailLink = linkFromArgs(process.argv) ?? null
  app.on('open-url', (event, value) => {
    const target = parseMailLink(value)
    if (!target) return
    event.preventDefault()
    receiveMailLink(target)
  })
  app.on('second-instance', (_event, args) => {
    const target = linkFromArgs(args)
    if (target) receiveMailLink(target)
    else if (app.isReady() && feedback) openWindow()
  })
  void app
    .whenReady()
    .then(() => {
      if (app.isPackaged && !customProfile && process.platform !== 'linux')
        app.setAsDefaultProtocolClient('amc')
      void pruneAgentSearches(profile).catch((error) => operationFailure('t3-launch', error))
      protectRemoteImageRequests(session.defaultSession)
      feedback = registerFeedbackIpc(() => window, openWindow, logDirectory, desktopLogger)
      buildMenu()
      triage = new AutoTriage({
        enabled: !existsSync(triageOffFile()),
        lastRun: loadLastTriageRun(),
        onLowBattery,
        accountForRun: (accountId, pending, recent) =>
          openReplica().triageAccount(accountId, pending, recent ? 'recent' : 'account'),
        log: desktopLogger,
        saveLastRun: (run) => {
          try {
            const path = triageRunFile()
            writeFileSync(`${path}.tmp`, JSON.stringify(run), { mode: 0o600 })
            renameSync(`${path}.tmp`, path)
          } catch (error) {
            operationFailure('triage-write', error)
          }
        },
        changed: (status) => broadcast('amc:triageStatus', status),
      })
      registerIpc(logDirectory)
      openReplica()
      const packagedMac = process.platform === 'darwin' && app.isPackaged
      const loginItem = packagedMac && !customProfile
      const settingsPath = notificationSettingsFile()
      if (existsSync(settingsPath)) {
        try {
          notificationSettings = parseNotificationSettings(
            JSON.parse(readFileSync(settingsPath, 'utf8')),
          )
        } catch (error) {
          operationFailure('notification-settings', error)
        }
      }
      if (process.platform === 'darwin') {
        tray = createTray(openWindow, openSettings, feedback.open, toggleSync, loginItem)
        if (Notification.isSupported()) {
          // Keep Electron's JavaScript wrappers alive while their alerts can be clicked.
          const active = new Set<Notification>()
          notifications = new NewMailNotifications(
            openReplica(),
            () => notificationSettings,
            ({ threadId, ...options }) => {
              const source = engine
              const notification = new Notification(options)
              active.add(notification)
              const release = () => active.delete(notification)
              notification.once('close', release)
              notification.once('click', () => {
                release()
                if (engine !== source) return
                pendingMailLink = null
                pendingThreadId = threadId
                openWindow()
                openPendingThread()
              })
              notification.once('failed', (_event, error) => {
                release()
                operationFailure('notification-show', new Error(String(error)))
              })
              notification.show()
            },
          )
        }
      }
      refreshTray()
      restoreSavedPairing()
      if (startupStatus.phase === 'unpaired') {
        // Scriptable first run: --engine-url=… --pairing-code=…
        const arg = (name: string) =>
          process.argv.find((a) => a.startsWith(`--${name}=`))?.split('=')[1]
        const url = arg('engine-url')
        const code = arg('pairing-code')
        if (url && code)
          void pair(url, code).catch(() => {
            /* pair records its failure before rejecting. */
          })
      }
      if (pendingMailLink || !loginItem || !app.getLoginItemSettings().wasOpenedAtLogin) {
        if (!window) createWindow()
      }
      app.on('activate', openWindow)
      app.on('browser-window-focus', refreshTray)
    })
    .catch((error) => {
      operationFailure('startup', error)
      app.quit()
    })
  app.on(
    'before-quit',
    createQuitHandler(
      () => {
        quittingTriage.abort()
        const stoppingTriage = stopSync()
        if (changedTimer) clearTimeout(changedTimer)
        return Promise.allSettled([
          flushDrafts(),
          Promise.resolve(stoppingTriage).finally(() =>
            Promise.all([settings.close(), closeClientLogs()]),
          ),
        ])
      },
      // The replica already has each staged edit. Exit even if the Engine or triage stalls.
      () => app.exit(0),
    ),
  )
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })
}
