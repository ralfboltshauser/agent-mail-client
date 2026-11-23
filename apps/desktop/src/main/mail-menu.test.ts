import type { Input } from 'electron'
import { expect, it, vi } from 'vitest'
import { handleMailRefreshKey, mailboxViewMenu } from './mail-menu'

it('exposes Check for New Mail with no production reload or DevTools roles', () => {
  const checkMail = vi.fn()
  const { submenu } = mailboxViewMenu(false, checkMail)
  if (!Array.isArray(submenu)) throw new Error('Missing View menu')
  expect(submenu.map((item) => item.role)).not.toContain('reload')
  expect(submenu.map((item) => item.role)).not.toContain('forceReload')
  expect(submenu.map((item) => item.role)).not.toContain('toggleDevTools')
  const command = submenu.find((item) => item.label === 'Check for New Mail')
  expect(command).toMatchObject({ accelerator: 'CommandOrControl+R', click: checkMail })
})

it('keeps a separate reload shortcut and DevTools in development', () => {
  expect(mailboxViewMenu(true, vi.fn()).submenu).toEqual(
    expect.arrayContaining([
      { role: 'reload', accelerator: 'CommandOrControl+Alt+Shift+R' },
      { role: 'toggleDevTools' },
    ]),
  )
})

it.each([
  [{ meta: true }, true, true],
  [{ control: true }, true, true],
  [{ meta: true, isAutoRepeat: true }, true, false],
  [{ meta: true, type: 'keyUp' }, true, false],
  [{ meta: true, shift: true, key: 'R' }, true, false],
  [{ control: true, shift: true, key: 'R' }, true, false],
  [{ key: 'F5' }, true, false],
  [{ meta: true, alt: true, shift: true }, false, false],
  [{}, false, false],
] satisfies [Partial<Input>, boolean, boolean][])(
  'handles refresh input %j',
  (overrides, blocked, dispatched) => {
    const event = { preventDefault: vi.fn() }
    const checkMail = vi.fn()
    handleMailRefreshKey(
      event,
      {
        key: 'r',
        type: 'keyDown',
        isAutoRepeat: false,
        alt: false,
        control: false,
        meta: false,
        shift: false,
        ...overrides,
      },
      checkMail,
    )
    expect(event.preventDefault).toHaveBeenCalledTimes(Number(blocked))
    expect(checkMail).toHaveBeenCalledTimes(Number(dispatched))
  },
)
