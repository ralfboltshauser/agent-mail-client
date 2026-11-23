import type { Input, MenuItemConstructorOptions } from 'electron'

export function mailboxViewMenu(dev: boolean, checkMail: () => void): MenuItemConstructorOptions {
  return {
    label: 'View',
    submenu: [
      {
        label: 'Check for New Mail',
        accelerator: 'CommandOrControl+R',
        click: checkMail,
      },
      ...(dev
        ? ([
            { role: 'reload', accelerator: 'CommandOrControl+Alt+Shift+R' },
            { role: 'toggleDevTools' },
          ] satisfies MenuItemConstructorOptions[])
        : []),
      { type: 'separator' },
      { role: 'togglefullscreen' },
    ],
  }
}

/** Consume browser refresh keys before they reach the page or a native accelerator. */
export function handleMailRefreshKey(
  event: { preventDefault: () => void },
  input: Pick<Input, 'key' | 'meta' | 'control' | 'alt' | 'shift' | 'type' | 'isAutoRepeat'>,
  checkMail: () => void,
) {
  const refresh = !input.alt && input.key.toLowerCase() === 'r' && (input.meta || input.control)
  if (!refresh && input.key !== 'F5') return
  event.preventDefault()
  if (refresh && !input.shift && input.type === 'keyDown' && !input.isAutoRepeat) checkMail()
}
