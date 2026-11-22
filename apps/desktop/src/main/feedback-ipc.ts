import { randomUUID } from 'node:crypto'
import { app, type BrowserWindow, clipboard, type IpcMainEvent, ipcMain, shell } from 'electron'
import { type FeedbackDraft, feedbackView } from '../shared/feedback'
import {
  type FeedbackContext,
  feedbackMessage,
  feedbackProject,
  launchFeedback,
  saveFeedbackCapture,
} from './feedback'
import { t3NavigationLink } from './handoff'
import { pairedFeedbackLauncher, savedT3Url } from './t3'
import { cliLauncher, detectT3Cli } from './t3-cli'

declare const AMC_REVISION: string

export function registerFeedbackIpc(getWindow: () => BrowserWindow | null, openWindow: () => void) {
  let ready = false
  let pending = false
  let captureAllowed = false
  let capture: { id: string; path: string; context: FeedbackContext } | null = null
  let rendererGeneration = 0
  let busy = false

  function trusted(event: Pick<IpcMainEvent, 'sender' | 'senderFrame'>) {
    return event.sender === getWindow()?.webContents && event.senderFrame === event.sender.mainFrame
  }

  function flushOpen() {
    if (!ready || !pending) return
    pending = false
    const window = getWindow()
    if (!window || capture || busy) return
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
  ipcMain.handle('amc:feedbackCapture', async (event, view: unknown) => {
    if (!trusted(event) || !captureAllowed || capture || busy)
      throw new Error('AMC feedback is unavailable.')
    captureAllowed = false
    const generation = rendererGeneration
    const at = new Date()
    busy = true
    try {
      const image = await event.sender.capturePage()
      if (image.isEmpty() || generation !== rendererGeneration || !trusted(event))
        throw new Error('Window capture is unavailable.')
      const id = randomUUID()
      const path = saveFeedbackCapture(app.getPath('userData'), image.toPNG(), at)
      capture = {
        id,
        path,
        context: {
          at,
          view: feedbackView(view),
          ...image.getSize(),
          version: [app.getVersion(), AMC_REVISION].filter(Boolean).join(' '),
        },
      }
      return { id }
    } catch {
      throw new Error('AMC could not capture its window.')
    } finally {
      busy = false
    }
  })
  ipcMain.handle('amc:feedbackSend', async (event, id: string, draft: FeedbackDraft) => {
    const current = active(event, id)
    busy = true
    try {
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
      rendererGeneration += 1
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
