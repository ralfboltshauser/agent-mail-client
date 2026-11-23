import { createLogger, isCorrelationId } from '@amc/observability'
import type { BrowserWindow } from 'electron'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { feedbackCaptureLifetimeMs, feedbackProject } from './feedback'
import { registerFeedbackIpc } from './feedback-ipc'

const mocks = vi.hoisted(() => ({
  handle: vi.fn(),
  on: vi.fn(),
  openExternal: vi.fn(),
  localLauncher: vi.fn(),
  pairedLauncher: vi.fn(),
  savedUrl: vi.fn(),
  saveCapture: vi.fn(),
  saveExcerpt: vi.fn(),
  removeCapture: vi.fn(),
  pruneCaptures: vi.fn(),
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
  saveFeedbackExcerpt: mocks.saveExcerpt,
  removeFeedbackCapture: mocks.removeCapture,
  pruneFeedbackCaptures: mocks.pruneCaptures,
}))
vi.mock('./t3-cli', () => ({ localT3Launcher: mocks.localLauncher }))
vi.mock('./t3', () => ({
  pairedFeedbackLauncher: mocks.pairedLauncher,
  savedT3Url: mocks.savedUrl,
}))

const path = '/tmp/fixture/feedback/synthetic.png'
const excerpt = '/tmp/fixture/feedback/synthetic.logs.json'
const draft = { text: 'Synthetic note', markdown: 'Synthetic annotation' }
const link = 't3code://threads/test-env/test-thread'

beforeEach(() => {
  vi.resetAllMocks()
  vi.stubGlobal('AMC_REVISION', 'test')
  mocks.saveCapture.mockReturnValue(path)
  mocks.saveExcerpt.mockResolvedValue(excerpt)
})

afterEach(() => vi.useRealTimers())

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
  const events: string[] = []
  const feedback = registerFeedbackIpc(
    () => ({ webContents: sender }) as unknown as BrowserWindow,
    vi.fn(),
    '/tmp/fixture/logs',
    createLogger({ component: 'main', sink: (line) => events.push(line) }),
  )
  mocks.on.mock.calls.find(([channel]) => channel === 'amc:feedbackReady')?.[1](event)
  feedback.open()
  const handler = (name: string) =>
    mocks.handle.mock.calls.find(([channel]) => channel === `amc:feedback${name}`)?.[1]
  const { id } = await handler('Capture')(event, 'setup')
  return {
    events,
    feedback,
    send: (captureId: string = id) => handler('Send')(event, captureId, draft),
    release: () => handler('Release')(event, id),
  }
}

describe('feedback IPC', () => {
  it('prefers the local launcher and supplies only the main-owned target and screenshot', async () => {
    const launch = vi.fn().mockResolvedValue({ threadId: 'test-thread', link })
    mocks.localLauncher.mockResolvedValue({ launch })
    mocks.savedUrl.mockReturnValue('http://localhost:3773/mcp')
    const { events, send } = await captureFeedback()

    await expect(send()).resolves.toEqual({ opened: true })
    expect(launch).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        projectId: feedbackProject,
        workspaceStrategy: { type: 'root' },
        message: expect.stringContaining(`Local log excerpt: ${excerpt}`),
      }),
      path,
    )
    expect(launch.mock.calls[0][0]).not.toHaveProperty('runtimeMode')
    expect(mocks.pairedLauncher).not.toHaveBeenCalled()
    expect(mocks.openExternal).toHaveBeenCalledExactlyOnceWith(link)
    expect(mocks.saveExcerpt).toHaveBeenCalledWith(path, '/tmp/fixture/logs', expect.any(Date))
    expect(events.map((event) => JSON.parse(event).event)).toEqual([
      'feedback.launch.started',
      'feedback.launch.finished',
    ])
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
    const { events, send } = await captureFeedback()

    await expect(send()).resolves.toEqual({
      opened: false,
      reason: expect.stringContaining(
        'AMC could not find a local T3 connection. Details: Error · run ',
      ),
    })
    expect(events.map((event) => JSON.parse(event))).toContainEqual(
      expect.objectContaining({ event: 'feedback.launch.finished', stage: 'LauncherUnavailable' }),
    )
  })

  it('reports a launch failure without exposing prompt content or trying a second launcher', async () => {
    mocks.localLauncher.mockResolvedValue({
      launch: vi.fn().mockRejectedValue(new Error(draft.text)),
    })
    const { events, send } = await captureFeedback()

    const result = await send()
    expect(result).toMatchObject({ opened: false, reason: expect.stringContaining('confirm') })
    expect(result.reason).not.toContain(draft.text)
    const [started, finished] = events.map((event) => JSON.parse(event))
    expect(started).toMatchObject({ event: 'feedback.launch.started' })
    expect(isCorrelationId(started.runId)).toBe(true)
    expect(finished).toMatchObject({
      event: 'feedback.launch.finished',
      status: 'failed',
      stage: 'LaunchFailed',
      runId: started.runId,
      err: { class: 'Error', message: '[redacted]' },
    })
    expect(events.join('')).not.toContain(draft.text)
    expect(result.reason).toContain(started.runId)
    expect(mocks.pairedLauncher).not.toHaveBeenCalled()
    expect(mocks.openExternal).not.toHaveBeenCalled()
  })

  it('rejects stale IDs and cleans up expired captures', async () => {
    vi.useFakeTimers()
    const { send } = await captureFeedback()
    expect(await send('stale')).toMatchObject({ opened: false })
    expect(mocks.removeCapture).not.toHaveBeenCalled()
    vi.setSystemTime(Date.now() + feedbackCaptureLifetimeMs)
    expect(await send()).toMatchObject({ opened: false })
    expect(mocks.removeCapture).toHaveBeenCalledExactlyOnceWith(path)
    expect(mocks.localLauncher).not.toHaveBeenCalled()
  })

  it('prunes retained artifacts on startup and while the app is idle', async () => {
    vi.useFakeTimers()
    const { release, send } = await captureFeedback()
    expect(mocks.pruneCaptures).toHaveBeenCalledExactlyOnceWith('/tmp/fixture')
    mocks.localLauncher.mockResolvedValue({
      launch: vi.fn().mockResolvedValue({ threadId: 'test' }),
    })
    await expect(send()).resolves.toEqual({ opened: true })
    await release()
    expect(mocks.removeCapture).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000)
    expect(mocks.pruneCaptures).toHaveBeenCalledTimes(2)
  })

  it('cleans up a released capture which was never handed to T3', async () => {
    const { send, release } = await captureFeedback()
    await release()
    expect(await send()).toMatchObject({ opened: false })
    expect(mocks.removeCapture).toHaveBeenCalledExactlyOnceWith(path)
  })

  it('reports when the thread exists but the desktop app could not open', async () => {
    mocks.localLauncher.mockResolvedValue({
      launch: vi.fn().mockResolvedValue({ threadId: 'test-thread', link }),
    })
    mocks.openExternal.mockRejectedValue(new Error('fixture'))
    const { events, send } = await captureFeedback()

    await expect(send()).resolves.toMatchObject({
      opened: false,
      reason: expect.stringContaining('created'),
    })
    expect(mocks.openExternal.mock.calls).toEqual([[link], ['t3code://']])
    expect(events.map((event) => JSON.parse(event))).toContainEqual(
      expect.objectContaining({ event: 'feedback.launch.finished', stage: 'OpenFailed' }),
    )
  })
})
