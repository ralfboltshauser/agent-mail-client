import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { hostname, tmpdir } from 'node:os'
import { join } from 'node:path'
import type {
  ComposeDraft,
  ComposePatch,
  ComposeStart,
  Draft,
  OutboxItem,
  PairResponse,
  SendRequest,
} from '@amc/protocol'
import { BucketInput } from '@amc/protocol'
import { app, BrowserWindow, ipcMain, Menu, nativeTheme, shell } from 'electron'
import type { SyncStatus, ThreadQuery } from '../shared/api'
import { clearPairing, loadPairing, savePairing } from './auth'
import { composeDraftPath } from './draft-updates'
import { EngineClient, EngineError } from './engine'
import { OrganiseSync } from './organise'
import { Replica } from './replica'
import { SyncLoop } from './sync'
import { createTray } from './tray'

let window: BrowserWindow | null = null
let replica: Replica | null = null
let engine: EngineClient | null = null
let sync: SyncLoop | null = null
let organise: OrganiseSync | null = null
let pausedStatus: SyncStatus | null = null
let tray: ReturnType<typeof createTray> | null = null
let changedTimer: NodeJS.Timeout | null = null
let draftRecovery: Promise<void> | null = null

const UNPAIRED: SyncStatus = {
  phase: 'unpaired',
  engineUrl: null,
  progress: null,
  lastSyncAt: null,
  error: null,
}

let unpairedStatus = UNPAIRED
const pauseFile = () => join(app.getPath('userData'), 'sync-paused')

function broadcast(channel: string, payload?: unknown) {
  window?.webContents.send(channel, payload)
}

function openReplica(): Replica {
  replica ??= new Replica(join(app.getPath('userData'), 'replica.db'))
  return replica
}

function refreshTray() {
  if (tray)
    tray.refresh(engine ? openReplica().counts(null).inboxUnread : 0, !!engine, !!pausedStatus)
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
  if (existsSync(pauseFile())) {
    organise = createOrganise(engine)
    pausedStatus = { ...UNPAIRED, phase: 'paused', engineUrl }
    broadcast('amc:status', pausedStatus)
  } else {
    startSync(engine)
  }
  refreshTray()
}

function startSync(client: EngineClient) {
  pausedStatus = null
  const updates = openReplica().draftUpdates
  const recovering = updates.flush(client)
  draftRecovery = recovering
  const loop = new SyncLoop(client, openReplica())
  sync = loop
  organise = createOrganise(client, loop)
  broadcast('amc:status', loop.status)
  let replayOnLive = true
  loop.on('status', (status) => {
    if (sync !== loop) return
    broadcast('amc:status', status)
    if (status.phase === 'live' && replayOnLive) {
      replayOnLive = false
      draftRecovery = recovering.then(() => {
        if (sync === loop) return updates.flush(client)
      })
    }
  })
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
  sync?.stop()
  sync = null
  organise?.stop()
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
  ipcMain.handle('amc:pair', (_e, engineUrl: string, code: string) => pair(engineUrl, code))
  ipcMain.handle('amc:unpair', () => {
    stopSync()
    organise = null
    pausedStatus = null
    engine = null
    clearPairing()
    openReplica().clear()
    openReplica().organise.clear()
    openReplica().draftUpdates.clear()
    draftRecovery = null
    unpairedStatus = UNPAIRED
    broadcast('amc:status', unpairedStatus)
    refreshTray()
  })
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
  const previousUrl = engine?.baseUrl ?? unpairedStatus.engineUrl
  savePairing(url, body.token)
  stopSync()
  if (previousUrl !== url) {
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
  const compose = '/v1/compose'
  const draftPath = composeDraftPath
  const signaturePath = (id: string) => `${compose}/signature/${encodeURIComponent(id)}`
  ipcMain.handle('amc:startCompose', (_e, body: ComposeStart) =>
    requireEngine().request(`${compose}/drafts`, { method: 'POST', body }),
  )
  ipcMain.handle(
    'amc:composeDrafts',
    async () => (await requireEngine().get<{ drafts: Draft[] }>(`${compose}/drafts`)).drafts,
  )
  ipcMain.handle('amc:composeDraft', async (_e, id: string) => {
    await draftRecovery
    return requireEngine().get(draftPath(id))
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
    })
    openReplica().draftUpdates.acknowledge(id, body.update)
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
    if (body.edits) openReplica().draftUpdates.acknowledge(body.draftId, body.edits.update)
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

  ipcMain.handle('amc:status', () => sync?.status ?? pausedStatus ?? unpairedStatus)
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
  window.once('ready-to-show', () => window?.show())
  // Never let the app window navigate away or open windows; links go to the browser.
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (/^(https?|mailto):/.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  window.webContents.on('will-navigate', (event, url) => {
    if (url !== window?.webContents.getURL()) event.preventDefault()
  })
  if (!app.isPackaged && process.env.ELECTRON_RENDERER_URL) {
    void window.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else void window.loadFile(join(import.meta.dirname, '../renderer/index.html'))
  const current = window
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
    // Keep the same app name at safeStorage initialization as the dev build.
    app.setName('AMC')
    buildMenu()
    registerIpc()
    openReplica()
    const packagedMac = process.platform === 'darwin' && app.isPackaged
    const loginItem = packagedMac && !customProfile
    if (process.platform === 'darwin') tray = createTray(openWindow, toggleSync, loginItem)
    refreshTray()
    const pairing = loadPairing()
    if (pairing?.token) connect(pairing.engineUrl, pairing.token)
    else {
      if (pairing) {
        unpairedStatus = {
          ...UNPAIRED,
          engineUrl: pairing.engineUrl,
          error:
            "AMC couldn't read its saved pairing (the app changed). Pair again with `sudo amc-engine pair --desktop` on the Host.",
        }
      }
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
    stopSync()
    if (changedTimer) clearTimeout(changedTimer)
    void flushDrafts().finally(() => {
      quitting = true
      app.quit()
    })
  })
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })
}
