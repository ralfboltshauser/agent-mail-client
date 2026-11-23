import { join } from 'node:path'
import {
  createLogger,
  type EventFields,
  type Logger,
  newRunId,
  type RunId,
  resolveLogLevel,
  sanitizeError,
} from '@amc/observability'
import { activeFileSink, macLogDirectory, stackFilePaths } from '@amc/observability/node'
import { app, type BrowserWindow, clipboard, type IpcMainEvent, ipcMain, shell } from 'electron'
import { type FeedbackDraft, type FeedbackSendResult, feedbackView } from '../shared/feedback'
import {
  type FeedbackContext,
  feedbackCaptureLifetimeMs,
  feedbackMessage,
  feedbackProject,
  launchFeedback,
  pruneFeedbackCaptures,
  removeFeedbackCapture,
  saveFeedbackCapture,
  saveFeedbackExcerpt,
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

type Stage = EventFields<'feedback.launch.failed'>['stage']

function desktopLogDirectory() {
  const profile = app.getPath('userData')
  return profile === join(app.getPath('appData'), '@amc', 'desktop')
    ? macLogDirectory()
    : join(profile, 'logs')
}

function feedbackLog() {
  return createLogger({
    component: 'main',
    level: resolveLogLevel(process.env.AMC_LOG_LEVEL),
    sink: (line) => activeFileSink(join(desktopLogDirectory(), 'main.log'))?.(line),
    stackFiles: stackFilePaths([
      [new URL(import.meta.url), 'desktop/feedback'],
      [new URL('./feedback.ts', import.meta.url), 'desktop/feedback'],
    ]),
  })
}

export function registerFeedbackIpc(
  getWindow: () => BrowserWindow | null,
  openWindow: () => void,
  log: (stage: Stage) => void,
  logger: Logger = feedbackLog(),
) {
  let ready = false
  let pending = false
  let captureAllowed = false
  let capture: {
    id: RunId
    path: string
    excerpt?: string
    context: FeedbackContext
    retained: boolean
  } | null = null
  let rendererGeneration = 0
  let busy = false

  function clearCapture() {
    const current = capture
    capture = null
    if (!current || current.retained) return
    try {
      removeFeedbackCapture(current.path)
    } catch (error) {
      logger.log(
        'warn',
        'feedback.capture.failed',
        { stage: 'CleanupFailed', err: error },
        { runId: current.id },
      )
    }
  }

  function expireCapture() {
    if (capture && Date.now() - capture.context.at.getTime() >= feedbackCaptureLifetimeMs)
      clearCapture()
  }

  function pruneCaptures() {
    expireCapture()
    try {
      pruneFeedbackCaptures(app.getPath('userData'))
    } catch (err) {
      logger.log('warn', 'feedback.capture.failed', { stage: 'CleanupFailed', err })
    }
  }
  pruneCaptures()
  setInterval(pruneCaptures, 60 * 60 * 1000).unref()

  function trusted(event: Pick<IpcMainEvent, 'sender' | 'senderFrame'>) {
    return event.sender === getWindow()?.webContents && event.senderFrame === event.sender.mainFrame
  }

  function flushOpen() {
    if (!ready || !pending) return
    expireCapture()
    pending = false
    const window = getWindow()
    if (!window || capture || busy) return
    captureAllowed = true
    window.webContents.send('amc:feedbackOpen')
  }

  function active(event: Pick<IpcMainEvent, 'sender' | 'senderFrame'>, id: string) {
    expireCapture()
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
    const id = newRunId()
    busy = true
    try {
      const image = await event.sender.capturePage()
      if (image.isEmpty() || generation !== rendererGeneration || !trusted(event))
        throw new Error('Window capture is unavailable.')
      const path = saveFeedbackCapture(app.getPath('userData'), image.toPNG(), at)
      const excerpt = await saveFeedbackExcerpt(path, desktopLogDirectory(), at).catch(
        (error: unknown) => {
          logger.log(
            'warn',
            'feedback.capture.failed',
            { stage: 'ExcerptFailed', err: error },
            { runId: id },
          )
          return undefined
        },
      )
      if (generation !== rendererGeneration || !trusted(event)) {
        removeFeedbackCapture(path)
        throw new Error('Window capture is unavailable.')
      }
      capture = {
        id,
        path,
        excerpt,
        retained: false,
        context: {
          at,
          view: feedbackView(view),
          ...image.getSize(),
          version: [app.getVersion(), AMC_REVISION].filter(Boolean).join(' '),
        },
      }
      return { id }
    } catch (error) {
      log('CaptureFailed')
      logger.log(
        'warn',
        'feedback.capture.failed',
        { stage: 'CaptureFailed', err: error },
        { runId: id },
      )
      throw new Error(
        `AMC could not capture its window. Details: ${sanitizeError(error).class} · run ${id}`,
      )
    } finally {
      busy = false
    }
  })
  ipcMain.handle('amc:feedbackSend', async (event, id: string, draft: FeedbackDraft) => {
    expireCapture()
    if (!trusted(event) || !capture || capture.id !== id || busy || !validDraft(draft)) {
      log('InvalidSubmission')
      return {
        opened: false,
        reason: 'Open Send Feedback again to capture AMC.',
      } satisfies FeedbackSendResult
    }
    const current = capture
    const scope = { runId: current.id }
    const start = performance.now()
    let stage: Stage | 'Opened' = 'LauncherUnavailable'
    const finish = (err?: unknown) => {
      logger.log(
        stage === 'Opened' ? 'info' : 'warn',
        'feedback.launch.finished',
        {
          operation: 'feedback.launch',
          status: stage === 'Opened' ? 'ok' : 'failed',
          stage,
          durationMs: performance.now() - start,
          err,
        },
        scope,
      )
    }
    const failed = (reason: string, error: unknown = new Error(reason)): FeedbackSendResult => {
      if (stage !== 'Opened') log(stage)
      finish(error)
      return {
        opened: false,
        reason: `${reason} Details: ${sanitizeError(error).class} · run ${current.id}`,
      }
    }

    logger.log('info', 'feedback.launch.started', { operation: 'feedback.launch' }, scope)
    busy = true
    try {
      const launcher = await feedbackLauncher()
      if (!launcher) return failed('AMC could not find a local T3 connection.')
      if (capture !== current) return failed('Open Send Feedback again to capture AMC.')

      stage = 'LaunchFailed'
      // A lost response can leave a live T3 thread with these local paths.
      current.retained = true
      const thread = await launchFeedback(
        launcher,
        feedbackProject,
        current.id,
        draft,
        current.context,
        current.path,
        current.excerpt,
      )
      if (!thread) return failed('T3 could not confirm the feedback thread.')

      stage = 'OpenFailed'
      const link = thread.link && t3NavigationLink(thread.link)
      const target =
        link && /^t3code:\/\/threads\/[^/?#]+\/[^/?#]+$/.test(link) ? link : 't3code://'
      try {
        await shell.openExternal(target)
      } catch (error) {
        logger.log('warn', 'feedback.capture.failed', { stage: 'OpenFailed', err: error }, scope)
        await shell.openExternal('t3code://')
      }
      stage = 'Opened'
      finish()
      return { opened: true } satisfies FeedbackSendResult
    } catch (error) {
      if (stage === 'LauncherUnavailable')
        return failed('AMC could not find a local T3 connection.', error)
      if (stage === 'OpenFailed')
        return failed('The feedback thread was created, but AMC could not open T3 Code.', error)
      return failed(
        'T3 could not confirm the feedback thread. Check that T3 Code is running and the AMC project is available.',
        error,
      )
    } finally {
      busy = false
    }
  })
  ipcMain.handle('amc:feedbackRelease', (event, id: string) => {
    if (trusted(event) && capture?.id === id) clearCapture()
  })
  ipcMain.handle('amc:feedbackCopy', (event, id: string, draft: FeedbackDraft) => {
    const current = active(event, id)
    if (!validDraft(draft)) throw new Error('Invalid feedback draft.')
    try {
      clipboard.writeText(feedbackMessage(draft, current.context, current.path, current.excerpt))
      current.retained = true
      shell.showItemInFolder(current.path)
    } catch (error) {
      logger.log(
        'warn',
        'feedback.capture.failed',
        { stage: 'CopyFailed', err: error },
        { runId: current.id },
      )
      throw new Error('AMC could not copy the feedback.')
    }
  })
  return {
    reset() {
      rendererGeneration += 1
      ready = false
      captureAllowed = false
      clearCapture()
    },
    open() {
      pending = true
      openWindow()
      flushOpen()
    },
  }
}
