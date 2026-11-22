import { randomUUID } from 'node:crypto'
import { chmodSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import {
  app,
  type BrowserWindow,
  clipboard,
  type IpcMainEvent,
  ipcMain,
  type NativeImage,
  shell,
} from 'electron'
import { type FeedbackDraft, feedbackView } from '../shared/feedback'
import {
  type FeedbackContext,
  feedbackMessage,
  feedbackProject,
  launchFeedback,
  saveFeedbackCapture,
} from './feedback'
import { markFeedbackImage } from './feedback-markers'
import { t3NavigationLink } from './handoff'
import { pairedFeedbackLauncher, savedT3Url } from './t3'
import { cliLauncher, detectT3Cli } from './t3-cli'

declare const AMC_REVISION: string

export function registerFeedbackIpc(getWindow: () => BrowserWindow | null, openWindow: () => void) {
  let ready = false
  let pending = false
  let captureAllowed = false
  let capture: { id: string; path: string; image: NativeImage; context: FeedbackContext } | null =
    null
  let busy = false

  function trusted(event: Pick<IpcMainEvent, 'sender' | 'senderFrame'>) {
    return event.sender === getWindow()?.webContents && event.senderFrame === event.sender.mainFrame
  }

  function flushOpen() {
    if (!ready || !pending) return
    pending = false
    const window = getWindow()
    if (!window || capture) return
    captureAllowed = true
    window.webContents.send('amc:feedbackOpen')
  }

  async function localCliLauncher() {
    const cli = await detectT3Cli()
    if (!cli) throw new Error('No local T3 connection.')
    return cliLauncher(cli)
  }

  function active(event: Pick<IpcMainEvent, 'sender' | 'senderFrame'>, id: string) {
    if (!trusted(event) || !capture || capture.id !== id || busy)
      throw new Error('Open Send Feedback again to capture AMC.')
    return capture
  }

  ipcMain.on('amc:feedbackReady', (event) => {
    if (!trusted(event)) return
    ready = true
    flushOpen()
  })
  ipcMain.handle('amc:feedbackCapture', async (event, view: unknown, viewport: unknown) => {
    if (!trusted(event) || !captureAllowed || busy) throw new Error('AMC feedback is unavailable.')
    captureAllowed = false
    const at = new Date()
    const image = await event.sender.capturePage().catch(() => null)
    if (!image || image.isEmpty() || !trusted(event))
      throw new Error('AMC could not capture its window.')
    const { width, height } = image.getSize()
    const context = {
      at,
      view: feedbackView(view),
      width,
      height,
      version: [app.getVersion(), AMC_REVISION].filter(Boolean).join(' '),
    }
    // DOM bounds are in CSS pixels. The window capture can use a different pixel density.
    const css = viewport as { width?: unknown; height?: unknown } | null
    const validDimension = (value: unknown): value is number =>
      typeof value === 'number' && Number.isInteger(value) && value > 0 && value < 100_000
    const cssViewport =
      css && validDimension(css.width) && validDimension(css.height)
        ? { width: css.width, height: css.height }
        : { width, height }
    const id = randomUUID()
    try {
      const path = saveFeedbackCapture(app.getPath('userData'), image.toPNG(), at)
      capture = { id, path, image, context: { ...context, ...cssViewport } }
    } catch {
      throw new Error('AMC could not save its window capture.')
    }
    return { id, ...cssViewport }
  })
  ipcMain.handle('amc:feedbackSend', async (event, id: string, draft: FeedbackDraft) => {
    const current = active(event, id)
    busy = true
    try {
      if (draft.annotations.length) {
        const marked = markFeedbackImage(current.image, draft.annotations, current.context)
        const temporary = `${current.path}.tmp`
        try {
          writeFileSync(temporary, marked, { mode: 0o600, flag: 'wx' })
          chmodSync(temporary, 0o600)
          renameSync(temporary, current.path)
        } finally {
          rmSync(temporary, { force: true })
        }
      }
      const address = savedT3Url()
      const localMcp =
        address && ['localhost', '127.0.0.1', '[::1]'].includes(new URL(address).hostname)
      const launcher = localMcp
        ? pairedFeedbackLauncher(address, localCliLauncher)
        : await localCliLauncher()
      const thread = await launchFeedback(
        launcher,
        feedbackProject,
        id,
        draft,
        current.context,
        current.path,
      )
      const link = thread.link && t3NavigationLink(thread.link)
      const target =
        link && /^t3code:\/\/threads\/[^/?#]+\/[^/?#]+$/.test(link) ? link : 't3code://'
      const opened = await shell.openExternal(target).then(
        () => true,
        () =>
          shell.openExternal('t3code://').then(
            () => true,
            () => false,
          ),
      )
      return { opened }
    } catch {
      // T3 and filesystem errors may include a signed URL or parts of the feedback.
      throw new Error(
        'T3 Code could not confirm the feedback thread. Open T3 Code or check AMC’s pairing, or copy your feedback.',
      )
    } finally {
      busy = false
    }
  })
  ipcMain.handle('amc:feedbackRelease', (event, id: string) => {
    if (trusted(event) && capture?.id === id) capture = null
  })
  ipcMain.handle('amc:feedbackCopy', (event, id: string, draft: FeedbackDraft) => {
    const { context, path } = active(event, id)
    clipboard.writeText(feedbackMessage(draft, context, path))
    shell.showItemInFolder(path)
  })
  return {
    reset() {
      ready = false
      captureAllowed = false
      capture = null
    },
    open() {
      pending = true
      openWindow()
      flushOpen()
    },
  }
}
