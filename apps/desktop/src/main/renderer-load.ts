import type { BrowserWindow } from 'electron'
import type { FailureDetails } from '../shared/failure'
import { failureScope, mainLog, operationFailure } from './observability'

export function loadRenderer(
  window: BrowserWindow,
  load: () => Promise<void>,
  showError: (reload: () => void, details: FailureDetails) => Promise<void>,
): void {
  let retried = false
  let scheduled = false
  let reporting = false
  let failed: FailureDetails | undefined
  let attempt = 0

  const reload = () => {
    if (window.isDestroyed()) return
    const current = ++attempt
    mainLog.log('debug', 'desktop.operation.started', { stage: 'renderer-load' })
    void load().then(
      () => {
        if (current !== attempt || scheduled || reporting || !failed) return
        mainLog.log(
          'info',
          'desktop.operation.finished',
          { stage: 'renderer-load' },
          failureScope(failed),
        )
        failed = undefined
      },
      (error: unknown) => {
        // Electron also emits did-fail-load. The recovery gate deduplicates the two reports.
        if (current === attempt) recover('renderer-load', error)
      },
    )
  }

  const recover = (stage: 'renderer-load' | 'renderer-crash', err: unknown) => {
    if (scheduled || reporting || window.isDestroyed()) return
    failed = operationFailure(stage, err)
    if (!retried) {
      retried = true
      scheduled = true
      // Let the failed navigation settle before beginning the next one.
      setImmediate(() => {
        scheduled = false
        reload()
      })
      return
    }
    reporting = true
    void showError(() => {
      reporting = false
      reload()
    }, failed).catch((error: unknown) => {
      reporting = false
      operationFailure('renderer-dialog', error)
    })
  }

  window.webContents.on('did-fail-load', (_event, code, _description, _url, isMainFrame) => {
    if (isMainFrame && code !== -3)
      recover('renderer-load', new Error('Renderer navigation failed'))
  })
  window.webContents.on('render-process-gone', () => {
    recover('renderer-crash', new Error('Renderer process exited'))
  })
  reload()
}
