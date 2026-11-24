import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export async function checkTriageReader(win, { origin, run, waitFor }) {
  const wc = win.webContents
  const press = async (key, code, windowsVirtualKeyCode, modifiers = 0) => {
    for (const type of ['keyDown', 'keyUp']) {
      await wc.debugger.sendCommand('Input.dispatchKeyEvent', {
        type,
        key,
        code,
        windowsVirtualKeyCode,
        modifiers,
        ...(type === 'keyDown' && key === ' ' ? { text: ' ' } : {}),
      })
    }
  }
  const capture = async (label) => {
    if (!process.env.AMC_TRIAGE_CAPTURE_DIR) return
    await run(
      () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
    )
    const path = join(process.env.AMC_TRIAGE_CAPTURE_DIR, `${label}.png`)
    await writeFile(path, (await wc.capturePage()).toPNG())
  }

  win.setContentSize(2120, 1050)
  await win.loadURL(new URL('?fixture=triage-reader', origin).href)
  await waitFor(() => run(() => !!document.querySelector('[aria-label="Threads"]')), 'Inbox')
  await run(() => document.querySelector('[aria-label="Threads"]').focus())
  await press('t', 'KeyT', 84)
  const frameReady = () =>
    run(() => Boolean(document.querySelector('[data-review-message] [data-reader-html-ready]')))
  await waitFor(frameReady, 'triage HTML rendered by default')
  const geometry = () =>
    run(() => {
      const pane = document.querySelector('[data-review-message]')
      const controls = document.querySelector('[aria-label="Triage decisions"]')
      const reader = pane.getBoundingClientRect()
      const actions = controls.getBoundingClientRect()
      return {
        readerHeight: reader.height,
        beside: actions.left >= reader.right && actions.top === reader.top,
        below: actions.top >= reader.bottom,
        actionsAtTop: controls.scrollTop === 0,
        fits: actions.bottom <= innerHeight && pane.scrollWidth <= pane.clientWidth,
      }
    })

  const wide = await geometry()
  assert.equal(wide.beside && wide.fits, true, JSON.stringify(wide))
  await capture('triage-wide')

  win.setContentSize(640, 560)
  await waitFor(async () => (await geometry()).below, 'stacked decisions at the minimum width')
  await waitFor(frameReady, 'fitted triage HTML')
  const compact = await geometry()
  assert.ok(compact.readerHeight > 200 && compact.fits, JSON.stringify(compact))
  await run(() => document.querySelector('[data-review-message]').focus())
  await press(' ', 'Space', 32)
  await waitFor(
    () => run(() => document.querySelector('[data-review-message]').scrollTop > 0),
    'Space scrolls the message',
  )
  assert.equal(
    await run(() => document.querySelector('[aria-label="Triage progress"]').textContent),
    '1/2',
  )

  const atEnd = await run(() => {
    const pane = document.querySelector('[data-review-message]')
    pane.scrollTop = pane.scrollHeight
    const frame = pane.querySelector('iframe')
    const line = frame.contentDocument.getElementById('triage-last').getBoundingClientRect()
    const paneBottom = pane.getBoundingClientRect().bottom
    return frame.getBoundingClientRect().top + line.bottom <= paneBottom
  })
  assert.ok(atEnd, 'the final line remains reachable within the reading pane')
  assert.ok((await geometry()).actionsAtTop, 'reading scroll leaves decisions in place')
  await capture('triage-compact')

  const focusLink = () =>
    run(() => {
      const frame = document.querySelector('[data-review-message] iframe')
      frame.contentDocument.getElementById('triage-link').focus()
      return document.activeElement === frame
    })
  assert.ok(await focusLink())
  await press('Tab', 'Tab', 9)
  await waitFor(
    () => run(() => Boolean(document.activeElement.closest('[aria-label="Triage decisions"]'))),
    'Tab exits the message into the decision controls',
  )
  await press('Tab', 'Tab', 9, 8)
  await waitFor(
    () =>
      run(
        () =>
          document.activeElement.tagName === 'IFRAME' &&
          document.activeElement.contentDocument.activeElement.id === 'triage-link',
      ),
    'Shift+Tab returns to the link',
  )

  await press('F', 'KeyF', 70, 8)
  await waitFor(
    () =>
      run(() => {
        const input = document.querySelector('[data-review-reason] input')
        if (!input || document.activeElement !== input) return false
        const controls = input.closest('aside').getBoundingClientRect()
        const field = input.getBoundingClientRect()
        return field.top >= controls.top && field.bottom <= controls.bottom
      }),
    'reason shortcut reveals its field at the bottom of the decision pane',
  )
  await press('Escape', 'Escape', 27)
  assert.ok(await focusLink())
  await press('Escape', 'Escape', 27)
  await waitFor(
    () => run(() => !document.querySelector('[data-review-message]')),
    'Escape exits triage from the HTML message',
  )
  console.log('Triage reader passed at desktop and minimum window sizes with native keyboard input')
}
