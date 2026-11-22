import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { hostname, tmpdir } from 'node:os'
import { join } from 'node:path'
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
  SenderAvatarResolve,
  SenderDecision,
  SenderListQuery,
  TriageQueueQuery,
} from '@amc/protocol'
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  Notification,
  nativeTheme,
  shell,
} from 'electron'
import type { SyncStatus, ThreadQuery, TriageStatus } from '../shared/api'
import { clearPairing, loadPairing, savePairing } from './auth'
import { AutoTriage } from './auto-triage'
import { composeDraftPath } from './draft-updates'
import { EngineClient, EngineError } from './engine'
import { Handoff, type T3Launcher, t3NavigationLink } from './handoff'
import {
  DEFAULT_NOTIFICATION_SETTINGS,
  NewMailNotifications,
  parseNotificationSettings,
} from './notifications'
import { OrganiseSync } from './organise'
import { loadRenderer } from './renderer-load'
import { Replica } from './replica'
import { SyncLoop } from './sync'
import { mcpLauncher, savedT3Url } from './t3'
import { cliLauncher, detectT3Cli } from './t3-cli'
import { createTray } from './tray'
import { onLowBattery, runTriageProcess } from './triage-process'

let window: BrowserWindow | null = null
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
const notificationSettingsFile = () => join(app.getPath('userData'), 'notifications.json')
let handoff: Handoff
let triage: AutoTriage
const quittingTriage = new AbortController()

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
    return Number.isFinite(run?.at) ? run : null
  } catch {
    return null
  }
}

function startupLog(event: string) {
  try {
    appendFileSync(
      join(app.getPath('userData'), 'startup.log'),
      `${new Date().toISOString()} [${process.pid}] ${event}\n`,
      {
        mode: 0o600,
      },
    )
  } catch {
    // Diagnostics must never prevent the app from opening.
  }
}

function setStartupStatus(status: SyncStatus) {
  startupStatus = status
  broadcast('amc:status', status)
}

function restoreSavedPairing() {
  startupLog('reading saved pairing')
  const pairing = loadPairing()
  if (pairing.state === 'paired') {
    startupLog('saved pairing loaded')
    connect(pairing.engineUrl, pairing.token)
  } else if (pairing.state === 'read-error') {
    startupLog('saved pairing unreadable')
    setStartupStatus({ ...UNPAIRED, phase: 'pairing-read-error', engineUrl: pairing.engineUrl })
  } else {
    setStartupStatus({ ...UNPAIRED, engineUrl: pairing.engineUrl })
  }
}

function broadcast(channel: string, payload?: unknown) {
  window?.webContents.send(channel, payload)
}

function openReplica(): Replica {
  replica ??= new Replica(join(app.getPath('userData'), 'replica.db'))
  return replica
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
  triage.connect((accountId, signal, recent) =>
    runTriageProcess({ engineUrl, token }, accountId, recent, signal, quittingTriage.signal),
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
      startupLog('Engine rejected saved pairing (401)')
      stopSync()
      engine = null
      organise = null
      triage.connect(null)
      setStartupStatus(status)
      refreshTray()
      return
    }
    if (replayOnLive && status.phase !== reportedPhase) {
      startupLog(`Engine sync phase: ${status.phase}`)
      reportedPhase = status.phase
    }
    broadcast('amc:status', status)
    triage.setAvailable(status.phase === 'live')
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
    console.error('Could not save the AMC sync preference', error)
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

function registerIpc() {
  ipcMain.handle('amc:notificationSettings', () => notificationSettings)
  ipcMain.handle('amc:saveNotificationSettings', (_event, input: unknown) => {
    const settings = parseNotificationSettings(input)
    const path = notificationSettingsFile()
    writeFileSync(`${path}.tmp`, JSON.stringify(settings), { mode: 0o600 })
    renameSync(`${path}.tmp`, path)
    notificationSettings = settings
    if (!settings.enabled) notifications?.clear()
  })
  ipcMain.on('amc:threadNavigationReady', (event) => {
    if (event.sender !== window?.webContents) return
    threadNavigationReady = true
    openPendingThread()
  })
  ipcMain.handle('amc:triageStatus', () => triage.status)
  ipcMain.handle('amc:setAutoTriage', (_e, enabled: unknown) => {
    if (typeof enabled !== 'boolean') throw new Error('Invalid auto-triage setting')
    if (enabled) rmSync(triageOffFile(), { force: true })
    else writeFileSync(triageOffFile(), '')
    triage.setEnabled(enabled)
  })
  ipcMain.handle('amc:triageCounts', (_e, accountId: unknown) => {
    if (accountId !== null && typeof accountId !== 'string') throw new Error('Invalid Account')
    return openReplica().triageCounts(accountId)
  })
  ipcMain.handle('amc:triageNow', async (_e, accountId: unknown, scope: unknown) => {
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
  ipcMain.handle('amc:pair', (_e, engineUrl: string, code: string) => pair(engineUrl, code))
  ipcMain.handle('amc:retrySavedPairing', () => {
    if (startupStatus.phase === 'pairing-read-error') return restoreSavedPairing()
  })
  ipcMain.handle('amc:unpair', () => {
    stopSync()
    organise = null
    pausedStatus = null
    engine = null
    pendingThreadId = null
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
  ipcMain.handle('amc:listSenders', (_event, query: unknown) =>
    requireEngine().get(`/v1/senders?${queryString(SenderListQuery.parse(query))}`),
  )
  ipcMain.handle('amc:decideSender', (_event, input: unknown) =>
    requireEngine().request('/v1/senders/decisions', {
      method: 'POST',
      body: SenderDecision.parse(input),
    }),
  )
  ipcMain.handle('amc:adoptScreenedDestination', (_event, input: unknown) =>
    requireEngine().request('/v1/senders/destination/adopt', {
      method: 'POST',
      body: AdoptScreenedDestination.parse(input),
    }),
  )
  ipcMain.handle('amc:ownerAction', (_event, id: string) =>
    requireEngine().get(`/v1/owner-actions/${encodeURIComponent(id)}`),
  )
  ipcMain.handle('amc:undoOwnerAction', (_event, id: string) =>
    requireEngine().request(`/v1/owner-actions/${encodeURIComponent(id)}/undo`, { method: 'POST' }),
  )
  ipcMain.handle('amc:triageQueue', (_event, query: unknown) =>
    requireEngine().get(`/v1/triage/queue?${queryString(TriageQueueQuery.parse(query))}`),
  )
  ipcMain.handle('amc:resolveSenderAvatars', (_event, input: unknown) =>
    requireEngine().request('/v1/sender-avatars/resolve', {
      method: 'POST',
      body: SenderAvatarResolve.parse(input),
    }),
  )
  ipcMain.handle('amc:setBucket', async (_event, input: unknown) => {
    const body = BucketInput.parse(input)
    const loop = sync
    if (!loop) throw new Error('Resume sync to move Threads between Buckets')
    await requireEngine().request('/v1/bucket', {
      method: 'PUT',
      body,
      signal: AbortSignal.timeout(10_000),
    })
    void loop.pull().catch(() => {}) // The normal sync loop retries if this pull fails.
  })
  ipcMain.handle('amc:organise', (_event, input: unknown) => {
    if (!organise) throw new Error('Pair with the Engine first')
    const id = organise.enqueue(input, (sync?.status ?? pausedStatus)?.snoozeEnabled)
    refreshMail()
    if (sync) void organise.flush()
    return id
  })
  ipcMain.handle('amc:organiseErrors', () => openReplica().organise.errors())
  registerReadIpc()
  registerComposeIpc()
}

async function pair(engineUrl: string, code: string) {
  const url = new URL(engineUrl).origin
  const res = await fetch(new URL('/v1/auth/pair', url), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code, deviceName: `${hostname()} (desktop)` }),
  }).catch((error: Error) => {
    throw new Error(`Cannot reach the Engine at ${url}: ${error.message}`)
  })
  const body = (await res.json().catch(() => ({}))) as Partial<PairResponse> & {
    message?: string
  }
  if (!res.ok || !body.token) throw new Error(body.message ?? 'Pairing failed')
  if (body.kind !== 'desktop')
    throw new Error('That code is for the CLI. Run `sudo amc-engine pair --desktop` on the Host.')
  const previousUrl = engine?.baseUrl ?? startupStatus.engineUrl
  savePairing(url, body.token)
  stopSync()
  if (previousUrl !== url) {
    pendingThreadId = null
    const db = openReplica()
    db.transaction(() => {
      db.clear()
      db.organise.clear()
      db.draftUpdates.clear()
    })
    broadcast('amc:changed')
  }
  connect(url, body.token)
}

function registerComposeIpc() {
  handoff = new Handoff(openReplica().db)
  let local: T3Launcher | null = null
  ipcMain.handle('amc:t3Setup', async () => {
    const cli = local ? null : await detectT3Cli()
    if (cli) local = cliLauncher(cli)
    return { kind: local ? 'cli' : 'mcp', address: savedT3Url() }
  })
  const launcher = (address: string | null) => {
    if (address !== null) return mcpLauncher(address)
    if (!local) throw new Error('AMC could not find the local T3 CLI.')
    return local
  }
  ipcMain.handle('amc:t3Projects', (_e, address: string | null) => launcher(address).projects())
  ipcMain.handle(
    'amc:handoff',
    async (_e, address: string | null, projectId: string, threadId: string) => {
      await draftRecovery
      try {
        const { draft, thread } = await handoff.launch(
          requireEngine(),
          projectId,
          threadId,
          launcher(address),
        )
        const link = thread.link && t3NavigationLink(thread.link)
        if (link) void shell.openExternal(link).catch(() => {})
        return draft
      } finally {
        broadcast('amc:changed')
      }
    },
  )
  ipcMain.handle(
    'amc:cancelHandoff',
    async (_e, address: string | null, projectId: string, threadId: string) => {
      await handoff.cancel(requireEngine(), projectId, threadId, launcher(address))
      broadcast('amc:changed')
    },
  )
  ipcMain.handle('amc:activeHandoff', (_e, threadId: string) =>
    handoff.active(requireEngine(), threadId),
  )
  ipcMain.handle('amc:endHandoff', async (_e, id: string) => {
    await handoff.end(requireEngine(), id)
    broadcast('amc:changed')
  })
  const compose = '/v1/compose'
  const draftPath = composeDraftPath
  const signaturePath = (id: string) => `${compose}/signature/${encodeURIComponent(id)}`
  ipcMain.handle('amc:startCompose', (_e, body: ComposeStart) =>
    requireEngine().request(`${compose}/drafts`, { method: 'POST', body }),
  )
  ipcMain.handle(
    'amc:composeDrafts',
    async () =>
      (await requireEngine().get<{ drafts: VersionedDraft[] }>(`${compose}/drafts`)).drafts,
  )
  ipcMain.handle('amc:composeDraft', async (_e, id: string) => {
    await draftRecovery
    return requireEngine().get(draftPath(id), { signal: AbortSignal.timeout(15_000) })
  })
  ipcMain.handle('amc:discardDraft', async (_e, id: string, revision: number) => {
    const client = requireEngine()
    // Older Engines reject this route instead of discarding without a revision check.
    const result = await client.request<DiscardDraftResult>(`${draftPath(id)}/discard`, {
      method: 'POST',
      body: { revision },
    })
    if (engine === client) {
      openReplica().draftUpdates.discard(id)
      void sync?.pull().catch(() => {}) // Normal sync retries if this pull fails.
    }
    return result
  })
  ipcMain.on('amc:stageComposeBody', (event, id: string, patch: ComposePatch) => {
    try {
      openReplica().draftUpdates.stage(id, patch)
      event.returnValue = null
    } catch {
      event.returnValue = 'Could not save the draft locally'
    }
  })
  ipcMain.handle('amc:saveCompose', async (_e, id: string, body: ComposePatch) => {
    const saved = await requireEngine().request<ComposeDraft>(draftPath(id), {
      method: 'PUT',
      body,
      signal: AbortSignal.timeout(15_000),
    })
    openReplica().draftUpdates.acknowledge(id, body)
    return saved
  })
  ipcMain.handle(
    'amc:addComposeAttachment',
    (_e, id: string, filename: string, mimeType: string, bytes: Uint8Array, inline?: boolean) =>
      requireEngine().request(`${draftPath(id)}/attachments`, {
        method: 'POST',
        body: { filename, mimeType, inline, content: Buffer.from(bytes).toString('base64') },
      }),
  )
  ipcMain.handle('amc:composeImage', (_e, id: string, contentId: string) =>
    requireEngine().get(`${draftPath(id)}/inline?cid=${encodeURIComponent(contentId)}`),
  )
  ipcMain.handle('amc:sendDraft', async (_e, body: SendRequest) => {
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
  ipcMain.handle(
    'amc:outbox',
    async () => (await requireEngine().get<{ items: OutboxItem[] }>(`${compose}/outbox`)).items,
  )
  ipcMain.handle('amc:resolveSend', (_e, id: string, action: 'check' | 'reopen') =>
    requireEngine().request(`${compose}/outbox/${encodeURIComponent(id)}/resolve`, {
      method: 'POST',
      body: { action },
    }),
  )
  ipcMain.handle('amc:cancelSend', async (_e, id: string) => {
    await requireEngine().request(`${compose}/outbox/${encodeURIComponent(id)}/cancel`, {
      method: 'POST',
    })
  })
  ipcMain.handle('amc:signature', (_e, id: string) => requireEngine().get(signaturePath(id)))
  ipcMain.handle('amc:saveSignature', (_e, id: string, signature: string) =>
    requireEngine().request(signaturePath(id), { method: 'PUT', body: { signature } }),
  )
  ipcMain.handle('amc:sendSettings', () => requireEngine().get(`${compose}/settings`))
  ipcMain.handle('amc:saveSendSettings', (_e, undoSendSeconds: number) =>
    requireEngine().request(`${compose}/settings`, { method: 'PUT', body: { undoSendSeconds } }),
  )
}

function registerReadIpc() {
  ipcMain.handle('amc:agentActivity', (_e, before: unknown) => {
    if (before === undefined) return requireEngine().get('/v1/agent/log')
    if (typeof before !== 'number' || !Number.isSafeInteger(before) || before <= 0)
      throw new Error('Invalid activity cursor')
    return requireEngine().get(`/v1/agent/log?before=${before}`)
  })
  ipcMain.handle('amc:undoAgentAction', async (_e, id: unknown) => {
    if (typeof id !== 'string') throw new Error('Invalid action ID')
    await requireEngine().request(`/v1/agent/log/${encodeURIComponent(id)}/undo`, {
      method: 'POST',
    })
    void sync?.pull()
  })

  ipcMain.handle('amc:status', () => sync?.status ?? pausedStatus ?? startupStatus)
  ipcMain.handle('amc:syncNow', () => sync?.pull())

  ipcMain.handle('amc:accounts', () => openReplica().accounts())
  ipcMain.handle('amc:labels', (_e, accountId: string | null) => openReplica().labels(accountId))
  ipcMain.handle('amc:counts', (_e, accountId: string | null) => openReplica().counts(accountId))
  ipcMain.handle('amc:threads', (_e, query: ThreadQuery) => openReplica().threads(query))
  ipcMain.handle('amc:thread', (_e, id: string) => openReplica().thread(id))
  ipcMain.handle('amc:summaries', (_e, ids: string[]) => openReplica().summaries(ids))
  ipcMain.handle('amc:filter', (_e, text: string, accountId: string | null) =>
    openReplica().filter(text, accountId),
  )
  ipcMain.handle('amc:search', async (_e, text: string, accountId: string | null) => {
    const params = new URLSearchParams({
      q: text,
      limit: '50',
      ...(accountId ? { accountId } : {}),
    })
    return (await requireEngine().get<{ hits: unknown[] }>(`/v1/search?${params}`)).hits
  })
  ipcMain.handle('amc:contacts', async (_e, text: string) => {
    return (
      await requireEngine().get<{ contacts: unknown[] }>(
        `/v1/contacts?q=${encodeURIComponent(text)}`,
      )
    ).contacts
  })
  ipcMain.handle('amc:messageText', (_e, messageId: string) => openReplica().messageText(messageId))
  ipcMain.handle('amc:messageHtml', async (_e, messageId: string) => {
    const cached = openReplica().html(messageId)
    if (cached !== null) return cached
    try {
      const { html } = await requireEngine().get<{ html: string }>(
        `/v1/messages/${encodeURIComponent(messageId)}/html`,
      )
      openReplica().putHtml(messageId, html)
      return html
    } catch (error) {
      if (error instanceof EngineError && error.status === 404) return null
      throw error
    }
  })
  ipcMain.handle('amc:inlineAttachment', async (_e, attachmentId: string) => {
    const data = await requireEngine().bytes(`/v1/attachments/${encodeURIComponent(attachmentId)}`)
    return data.toString('base64')
  })
  ipcMain.handle('amc:openAttachment', async (_e, attachmentId: string, filename: string) => {
    const data = await requireEngine().bytes(`/v1/attachments/${encodeURIComponent(attachmentId)}`)
    const dir = join(tmpdir(), 'amc-attachments', attachmentId.replace(/[^\w.-]/g, '_'))
    mkdirSync(dir, { recursive: true })
    const path = join(dir, filename.replace(/[/\\]/g, '_') || 'attachment')
    writeFileSync(path, data)
    await shell.openPath(path)
  })
  ipcMain.handle('amc:openExternal', async (_e, url: string) => {
    const parsed = new URL(url)
    if (!['http:', 'https:', 'mailto:'].includes(parsed.protocol))
      throw new Error('Refusing to open that link')
    await shell.openExternal(parsed.toString())
  })
}

let quitting = false
let flushingBeforeQuit = false

async function flushDrafts() {
  await replica?.draftUpdates.flush(engine)
}

function openPendingThread() {
  if (!threadNavigationReady || !pendingThreadId) return
  const [thread] = openReplica().summaries([pendingThreadId])
  pendingThreadId = null
  if (thread) broadcast('amc:openThread', thread)
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
      devTools: !app.isPackaged,
    },
  })
  const current = window
  threadNavigationReady = false
  current.webContents.on('did-start-navigation', ({ isMainFrame, isSameDocument }) => {
    if (isMainFrame && !isSameDocument) threadNavigationReady = false
  })
  current.webContents.on('render-process-gone', () => {
    threadNavigationReady = false
  })
  current.once('ready-to-show', () => current.show())
  // Never let the app window navigate away or open windows; links go to the browser.
  current.webContents.setWindowOpenHandler(({ url }) => {
    if (/^(https?|mailto):/.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  current.webContents.on('will-navigate', (event, url) => {
    if (url !== current.webContents.getURL()) event.preventDefault()
  })
  const devUrl = app.isPackaged ? undefined : process.env.ELECTRON_RENDERER_URL
  loadRenderer(
    current,
    () =>
      devUrl
        ? current.loadURL(devUrl)
        : current.loadFile(join(import.meta.dirname, '../renderer/index.html')),
    async (reload) => {
      current.show()
      const { response } = await dialog.showMessageBox(current, {
        type: 'error',
        message: 'AMC is starting…',
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
    if (quitting || flushed) return
    event.preventDefault()
    if (closing) return
    closing = true
    void flushDrafts().finally(() => {
      flushed = true
      if (!current.isDestroyed()) current.close()
    })
  })
  window.on('closed', () => {
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

function buildMenu() {
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      { role: 'appMenu' },
      { role: 'editMenu' },
      {
        label: 'View',
        submenu: [
          { role: 'reload' },
          ...(!app.isPackaged ? [{ role: 'toggleDevTools' as const }] : []),
          { type: 'separator' },
          { role: 'togglefullscreen' },
        ],
      },
      { role: 'windowMenu' },
    ]),
  )
}

app.setName('AMC')
// Both the packaged app and electron-vite use the original dev profile by default.
const customProfile = app.commandLine.getSwitchValue('user-data-dir')
const profile = customProfile || join(app.getPath('appData'), '@amc', 'desktop')
mkdirSync(profile, { recursive: true })
app.setPath('userData', profile)

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', openWindow)
  app.whenReady().then(() => {
    buildMenu()
    triage = new AutoTriage({
      enabled: !existsSync(triageOffFile()),
      lastRun: loadLastTriageRun(),
      onLowBattery,
      accountForRun: (accountId, pending, recent) =>
        openReplica().triageAccount(accountId, pending, recent ? 'recent' : 'account'),
      saveLastRun: (run) => {
        try {
          const path = triageRunFile()
          writeFileSync(`${path}.tmp`, JSON.stringify(run), { mode: 0o600 })
          renameSync(`${path}.tmp`, path)
        } catch {
          console.error('Could not save the last AMC triage result')
        }
      },
      changed: (status) => broadcast('amc:triageStatus', status),
    })
    registerIpc()
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
        console.error('Could not load the AMC notification settings', error)
      }
    }
    if (process.platform === 'darwin') {
      tray = createTray(openWindow, toggleSync, loginItem)
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
              pendingThreadId = threadId
              openWindow()
              openPendingThread()
            })
            notification.once('failed', (_event, error) => {
              release()
              console.error('Could not show an AMC notification', error)
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
        void pair(url, code).catch((error: Error) =>
          console.error(`Pairing failed: ${error.message}`),
        )
    }
    if (!loginItem || !app.getLoginItemSettings().wasOpenedAtLogin) createWindow()
    app.on('activate', openWindow)
    app.on('browser-window-focus', refreshTray)
  })
  app.on('before-quit', (event) => {
    if (quitting) return
    event.preventDefault()
    if (flushingBeforeQuit) return
    flushingBeforeQuit = true
    quittingTriage.abort()
    const stoppingTriage = stopSync()
    if (changedTimer) clearTimeout(changedTimer)
    void Promise.allSettled([flushDrafts(), stoppingTriage]).then(() => {
      quitting = true
      app.quit()
    })
  })
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })
}
