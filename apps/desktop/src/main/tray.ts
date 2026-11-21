import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { app, Menu, nativeImage, Tray } from 'electron'

export function createTray(openWindow: () => void, toggleSync: () => void, loginItem: boolean) {
  const resources = app.isPackaged ? process.resourcesPath : join(app.getAppPath(), 'build')
  const image = nativeImage.createFromPath(join(resources, 'trayTemplate.png'))
  image.setTemplateImage(true)
  const tray = new Tray(image)
  const initialized = join(app.getPath('userData'), 'login-item-initialized')

  function setLoginItem(openAtLogin: boolean) {
    try {
      app.setLoginItemSettings({ openAtLogin })
      const status = app.getLoginItemSettings().status
      if (!openAtLogin || status === 'enabled' || status === 'requires-approval')
        writeFileSync(initialized, '')
    } catch (error) {
      console.error('Could not update the AMC login item', error)
    }
  }

  if (loginItem && !existsSync(initialized)) {
    const status = app.getLoginItemSettings().status
    if (status === 'enabled' || status === 'requires-approval') writeFileSync(initialized, '')
    else setLoginItem(true)
  }

  function refresh(unread: number, paired: boolean, paused: boolean) {
    tray.setTitle(unread ? unread.toLocaleString() : '')
    tray.setToolTip(`AMC · ${unread.toLocaleString()} unread in Inbox`)
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: 'Open AMC', click: openWindow },
        { type: 'separator' },
        { label: paused ? 'Resume Sync' : 'Pause Sync', enabled: paired, click: toggleSync },
        {
          label: 'Launch at Login',
          type: 'checkbox',
          visible: loginItem,
          checked: loginItem && app.getLoginItemSettings().openAtLogin,
          click: (item) => {
            setLoginItem(item.checked)
            refresh(unread, paired, paused)
          },
        },
        { type: 'separator' },
        { role: 'quit', label: 'Quit AMC' },
      ]),
    )
  }

  return { refresh }
}
