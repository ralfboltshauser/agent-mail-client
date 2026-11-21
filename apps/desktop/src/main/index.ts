import { mkdirSync, writeFileSync } from 'node:fs'
import { hostname, tmpdir } from 'node:os'
import { join } from 'node:path'
import type { PairResponse } from '@amc/protocol'
import { app, BrowserWindow, ipcMain, Menu, nativeTheme, shell } from 'electron'
import type { SyncStatus, ThreadQuery } from '../shared/api'
import { clearPairing, loadPairing, savePairing } from './auth'
import { EngineClient, EngineError } from './engine'
import { Replica } from './replica'
import { SyncLoop } from './sync'
import { createTray } from './tray'

let window: BrowserWindow | null = null
let replica: Replica | null = null
let engine: EngineClient | null = null
let sync: SyncLoop | null = null
let pausedStatus: SyncStatus | null = null
let tray: ReturnType<typeof createTray> | null = null
let changedTimer: NodeJS.Timeout | null = null

const UNPAIRED: SyncStatus = {
  phase: 'unpaired',
  engineUrl: null,
  progress: null,
  lastSyncAt: null,
  error: null,
}

function broadcast(channel: string, payload?: unknown) {
  window?.webContents.send(channel, payload)
}

function openReplica(): Replica {
  replica ??= new Replica(join(app.getPath('userData'), 'replica.db'))
  return replica
}

function refreshTray() {
  if (tray) tray.refresh(engine ? openReplica().unreadInboxCount() : 0, !!engine, !!pausedStatus)
}

function connect(engineUrl: string, token: string) {
  engine = new EngineClient(engineUrl, token)
  startSync(engine)
  refreshTray()
}

function startSync(client: EngineClient) {
  sync?.stop()
  pausedStatus = null
  const loop = new SyncLoop(client, openReplica())
  sync = loop
  broadcast('amc:status', loop.status)
  loop.on('status', (status) => {
    if (sync === loop) broadcast('amc:status', status)
  })
  loop.on('changed', () => {
    // Coalesce bursts (backfill pages) into one UI refresh per 120 ms.
    if (changedTimer) return
    changedTimer = setTimeout(() => {
      changedTimer = null
      broadcast('amc:changed')
      refreshTray()
    }, 120)
  })
  loop.start()
}

function toggleSync() {
  if (sync) {
    pausedStatus = { ...sync.status, phase: 'paused', progress: null, error: null }
    sync.stop()
    sync = null
    broadcast('amc:status', pausedStatus)
  } else if (engine) {
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
    sync?.stop()
    sync = null
    pausedStatus = null
    engine = null
    clearPairing()
    openReplica().clear()
    broadcast('amc:status', UNPAIRED)
    refreshTray()
  })
  registerReadIpc()
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
  savePairing(url, body.token)
  openReplica().clear()
  connect(url, body.token)
}

function registerReadIpc() {
  ipcMain.handle('amc:status', () => sync?.status ?? pausedStatus ?? UNPAIRED)
  ipcMain.handle('amc:syncNow', () => sync?.pull())

  ipcMain.handle('amc:accounts', () => openReplica().accounts())
  ipcMain.handle('amc:labels', (_e, accountId: string | null) => openReplica().labels(accountId))
  ipcMain.handle('amc:counts', (_e, accountId: string | null) => openReplica().counts(accountId))
  ipcMain.handle('amc:threads', (_e, query: ThreadQuery) => openReplica().threads(query))
  ipcMain.handle('amc:thread', (_e, id: string) => openReplica().thread(id))
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
  if (process.env.ELECTRON_RENDERER_URL) void window.loadURL(process.env.ELECTRON_RENDERER_URL)
  else void window.loadFile(join(import.meta.dirname, '../renderer/index.html'))
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
          { role: 'toggleDevTools' },
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
    if (pairing) connect(pairing.engineUrl, pairing.token)
    else {
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
  })
  app.on('before-quit', () => {
    sync?.stop()
    if (changedTimer) clearTimeout(changedTimer)
  })
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })
}
