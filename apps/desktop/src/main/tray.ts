import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { app, Menu, type MenuItemConstructorOptions, nativeImage, shell, Tray } from 'electron'
import { operationFailure } from './observability'

export function createTray(
  openWindow: () => void,
  openSettings: () => void,
  openFeedback: () => void,
  toggleSync: () => void,
  loginItem: boolean,
) {
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
      operationFailure('login-settings', error)
    }
  }

  if (loginItem && !existsSync(initialized)) {
    const status = app.getLoginItemSettings().status
    if (status === 'enabled' || status === 'requires-approval') writeFileSync(initialized, '')
    else setLoginItem(true)
  }

  function loginMenu(refresh: () => void): MenuItemConstructorOptions[] {
    if (!loginItem) return []
    const settings = app.getLoginItemSettings()
    if (settings.status === 'requires-approval') {
      return [
        { label: 'Launch at Login Needs Approval', enabled: false },
        {
          label: 'Open Login Items Settings',
          click: () => {
            void shell
              .openExternal('x-apple.systempreferences:com.apple.LoginItems-Settings.extension')
              .catch((error) => operationFailure('login-settings', error))
          },
        },
        {
          label: 'Cancel Launch at Login',
          click: () => {
            setLoginItem(false)
            refresh()
          },
        },
      ]
    }
    return [
      {
        label: 'Launch at Login',
        type: 'checkbox',
        checked: settings.openAtLogin,
        click: (item) => {
          setLoginItem(item.checked)
          refresh()
        },
      },
    ]
  }

  function refresh(attentionCount: number, paired: boolean, paused: boolean) {
    const count = attentionCount.toLocaleString()
    tray.setTitle(attentionCount ? count : '')
    tray.setToolTip(
      `AMC · ${count} ${attentionCount === 1 ? 'thread needs' : 'threads need'} a reply or action${paused ? ' · Sync paused' : ''}`,
    )
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: 'Open AMC', click: openWindow },
        { label: 'Settings…', click: openSettings },
        { label: 'Send Feedback…', click: openFeedback },
        { type: 'separator' },
        ...(paused ? [{ label: 'Sync paused', enabled: false }] : []),
        { label: paused ? 'Resume Sync' : 'Pause Sync', enabled: paired, click: toggleSync },
        ...loginMenu(() => refresh(attentionCount, paired, paused)),
        { type: 'separator' },
        { role: 'quit', label: 'Quit AMC' },
      ]),
    )
  }

  return { refresh }
}
