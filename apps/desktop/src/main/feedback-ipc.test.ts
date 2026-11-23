import type { BrowserWindow } from 'electron'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { feedbackProject } from './feedback'
import { registerFeedbackIpc } from './feedback-ipc'

const mocks = vi.hoisted(() => ({
  handle: vi.fn(),
  on: vi.fn(),
  openExternal: vi.fn(),
  localLauncher: vi.fn(),
  pairedLauncher: vi.fn(),
  savedUrl: vi.fn(),
  saveCapture: vi.fn(),
}))

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/fixture', getVersion: () => '1.0' },
  ipcMain: { on: mocks.on, handle: mocks.handle },
  shell: { openExternal: mocks.openExternal },
  clipboard: {},
}))
vi.mock('./feedback', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./feedback')>()),
  saveFeedbackCapture: mocks.saveCapture,
}))
vi.mock('./t3-cli', () => ({ localT3Launcher: mocks.localLauncher }))
vi.mock('./t3', () => ({
  pairedFeedbackLauncher: mocks.pairedLauncher,
  savedT3Url: mocks.savedUrl,
}))

const path = '/tmp/fixture/feedback/synthetic.png'
const draft = { text: 'Synthetic note', markdown: 'Synthetic annotation' }
const link = 't3code://threads/test-env/test-thread'

beforeEach(() => {
  vi.resetAllMocks()
  vi.stubGlobal('AMC_REVISION', 'test')
  mocks.saveCapture.mockReturnValue(path)
})

async function captureFeedback() {
  const sender = {
    mainFrame: {},
    send: vi.fn(),
    capturePage: async () => ({
      isEmpty: () => false,
      toPNG: () => Buffer.from([]),
      getSize: () => ({ width: 800, height: 600 }),
    }),
  }
  const event = { sender, senderFrame: sender.mainFrame }
  const log = vi.fn()
  const feedback = registerFeedbackIpc(
    () => ({ webContents: sender }) as unknown as BrowserWindow,
    vi.fn(),
    log,
  )
  mocks.on.mock.calls.find(([channel]) => channel === 'amc:feedbackReady')?.[1](event)
  feedback.open()
  const handler = (name: string) =>
    mocks.handle.mock.calls.find(([channel]) => channel === `amc:feedback${name}`)?.[1]
  const { id } = await handler('Capture')(event, 'setup')
  return { log, send: () => handler('Send')(event, id, draft) }
}

describe('feedback IPC', () => {
  it('prefers the local launcher and supplies only the main-owned target and screenshot', async () => {
    const launch = vi.fn().mockResolvedValue({ threadId: 'test-thread', link })
    mocks.localLauncher.mockResolvedValue({ launch })
    mocks.savedUrl.mockReturnValue('http://localhost:3773/mcp')
    const { log, send } = await captureFeedback()

    await expect(send()).resolves.toEqual({ opened: true })
    expect(launch).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ projectId: feedbackProject, workspaceStrategy: { type: 'root' } }),
      path,
    )
    expect(launch.mock.calls[0][0]).not.toHaveProperty('runtimeMode')
    expect(mocks.pairedLauncher).not.toHaveBeenCalled()
    expect(mocks.openExternal).toHaveBeenCalledExactlyOnceWith(link)
    expect(log).not.toHaveBeenCalled()
  })

  it('uses the saved local pairing when the CLI is unavailable', async () => {
    const address = 'http://localhost:3773/mcp'
    mocks.savedUrl.mockReturnValue(address)
    const launch = vi.fn().mockResolvedValue({ threadId: 'test-thread' })
    mocks.pairedLauncher.mockReturnValue({ launch })
    const { send } = await captureFeedback()
    await expect(send()).resolves.toEqual({ opened: true })
    expect(mocks.pairedLauncher).toHaveBeenCalledExactlyOnceWith(address)
    expect(launch).toHaveBeenCalledOnce()
  })

  it('reports a missing launcher and logs only a failure class', async () => {
    const { log, send } = await captureFeedback()

    await expect(send()).resolves.toEqual({
      opened: false,
      reason: 'AMC could not find a local T3 connection.',
    })
    expect(log).toHaveBeenCalledExactlyOnceWith('feedback send failed: LauncherUnavailable')
  })

  it('reports a launch failure without exposing prompt content or trying a second launcher', async () => {
    mocks.localLauncher.mockResolvedValue({
      launch: vi.fn().mockRejectedValue(new Error(draft.text)),
    })
    const { log, send } = await captureFeedback()

    const result = await send()
    expect(result).toMatchObject({ opened: false, reason: expect.stringContaining('confirm') })
    expect(result.reason).not.toContain(draft.text)
    expect(log).toHaveBeenCalledExactlyOnceWith('feedback send failed: LaunchFailed')
    expect(mocks.pairedLauncher).not.toHaveBeenCalled()
    expect(mocks.openExternal).not.toHaveBeenCalled()
  })

  it('reports when the thread exists but the desktop app could not open', async () => {
    mocks.localLauncher.mockResolvedValue({
      launch: vi.fn().mockResolvedValue({ threadId: 'test-thread', link }),
    })
    mocks.openExternal.mockRejectedValue(new Error('fixture'))
    const { log, send } = await captureFeedback()

    await expect(send()).resolves.toMatchObject({
      opened: false,
      reason: expect.stringContaining('created'),
    })
    expect(mocks.openExternal.mock.calls).toEqual([[link], ['t3code://']])
    expect(log).toHaveBeenCalledExactlyOnceWith('feedback send failed: OpenFailed')
  })
})
