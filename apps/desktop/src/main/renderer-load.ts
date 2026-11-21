import type { BrowserWindow } from 'electron'

export function loadRenderer(
  window: BrowserWindow,
  load: () => Promise<void>,
  showError: (reload: () => void) => Promise<void>,
): void {
  const reload = () => {
    if (window.isDestroyed()) return
    // Electron reports navigation failures through did-fail-load.
    void load().catch(() => {})
  }
  let retried = false
  let scheduled = false
  let reporting = false
  const recover = (reason: string) => {
    if (scheduled || reporting || window.isDestroyed()) return
    console.error(`AMC renderer failed: ${reason}`)
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
    }).catch((error: unknown) => console.error('Could not show renderer load error', error))
  }
  window.webContents.on('did-fail-load', (_event, code, description, _url, isMainFrame) => {
    if (isMainFrame && code !== -3) recover(`${description} (${code})`)
  })
  window.webContents.on('render-process-gone', (_event, details) => {
    recover(`${details.reason} (${details.exitCode})`)
  })
  reload()
}
