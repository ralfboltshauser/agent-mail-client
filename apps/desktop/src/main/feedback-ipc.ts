import { randomUUID } from 'node:crypto'
import type { EventFields } from '@amc/observability'
import { app, type BrowserWindow, clipboard, type IpcMainEvent, ipcMain, shell } from 'electron'
import { type FeedbackDraft, type FeedbackSendResult, feedbackView } from '../shared/feedback'
import {
  type FeedbackContext,
  feedbackMessage,
  feedbackProject,
  launchFeedback,
  saveFeedbackCapture,
} from './feedback'
import { type T3Launcher, t3NavigationLink } from './handoff'
import { pairedFeedbackLauncher, savedT3Url } from './t3'
import { localT3Launcher } from './t3-cli'

declare const AMC_REVISION: string

async function feedbackLauncher(): Promise<T3Launcher | undefined> {
  const local = await localT3Launcher()
  if (local) return local
  const address = savedT3Url()
  if (address && ['localhost', '127.0.0.1', '[::1]'].includes(new URL(address).hostname))
    return pairedFeedbackLauncher(address)
}

function validDraft(draft: FeedbackDraft) {
  return typeof draft?.text === 'string' && typeof draft.markdown === 'string'
}

export function registerFeedbackIpc(
  getWindow: () => BrowserWindow | null,
  openWindow: () => void,
  log: (stage: EventFields<'feedback.launch.failed'>['stage']) => void,
) {
  function failed(
    stage: EventFields<'feedback.launch.failed'>['stage'],
    reason: string,
  ): FeedbackSendResult {
    log(stage)
    return { opened: false, reason }
  }

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
    if (!trusted(event) || !captureAllowed || capture || busy) {
      log('CaptureUnavailable')
      throw new Error('AMC feedback is unavailable.')
    }
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
      log('CaptureFailed')
      throw new Error('AMC could not capture its window.')
    } finally {
      busy = false
    }
  })
  ipcMain.handle('amc:feedbackSend', async (event, id: string, draft: FeedbackDraft) => {
    if (!trusted(event) || !capture || capture.id !== id || busy || !validDraft(draft))
      return failed('InvalidSubmission', 'Open Send Feedback again to capture AMC.')
    const current = capture
    busy = true
    try {
      const launcher = await feedbackLauncher().catch(() => undefined)
      if (!launcher)
        return failed('LauncherUnavailable', 'AMC could not find a local T3 connection.')

      const thread = await launchFeedback(
        launcher,
        feedbackProject,
        current.id,
        draft,
        current.context,
        current.path,
      ).catch(() => null)
      if (!thread)
        return failed(
          'LaunchFailed',
          'T3 could not confirm the feedback thread. Check that T3 Code is running and the AMC project is available.',
        )

      const link = thread.link && t3NavigationLink(thread.link)
      const target =
        link && /^t3code:\/\/threads\/[^/?#]+\/[^/?#]+$/.test(link) ? link : 't3code://'
      try {
        await shell.openExternal(target)
      } catch {
        try {
          await shell.openExternal('t3code://')
        } catch {
          return failed(
            'OpenFailed',
            'The feedback thread was created, but AMC could not open T3 Code.',
          )
        }
      }
      return { opened: true } satisfies FeedbackSendResult
    } finally {
      busy = false
    }
  })
  ipcMain.handle('amc:feedbackRelease', (event, id: string) => {
    if (trusted(event) && capture?.id === id) capture = null
  })
  ipcMain.handle('amc:feedbackCopy', (event, id: string, draft: FeedbackDraft) => {
    const { context, path } = active(event, id)
    if (!validDraft(draft)) throw new Error('Invalid feedback draft.')
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
