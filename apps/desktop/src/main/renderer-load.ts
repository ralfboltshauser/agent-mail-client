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
  window.webContents.on('did-fail-load', (_event, code, description, _url, isMainFrame) => {
    if (!isMainFrame || code === -3 || scheduled || reporting || window.isDestroyed()) return
    console.error(`AMC renderer load failed: ${description} (${code})`)
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
    void showError(reload)
      .catch((error: unknown) => console.error('Could not show renderer load error', error))
      .finally(() => {
        reporting = false
      })
  })
  reload()
}
