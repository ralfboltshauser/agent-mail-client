import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { app, BrowserWindow, nativeTheme, session } from 'electron'
import { protectRemoteImageRequests } from '../../apps/desktop/src/main/message-image-requests.ts'
import { requests, startReaderServer } from './html-reader-server.mjs'
import { checkTriageReader } from './triage-reader.mjs'

const profile = mkdtempSync(join(tmpdir(), 'amc-html-reader-'))
app.setPath('userData', profile)
// Let main finish cleaning up and return the test result after closing the window.
app.on('window-all-closed', () => {})

const waitFor = async (probe, description) => {
  const deadline = Date.now() + 5000
  while (Date.now() < deadline) {
    const result = await probe()
    if (result) return result
    await delay(25)
  }
  throw new Error(`Timed out waiting for ${description}`)
}

async function checkMessageDetails(wc, run) {
  const trigger = 'button[aria-label="Show message details"]'
  const popup = '[role="dialog"][aria-label="Message details"]'
  const target = await run((selector) => {
    const button = document.querySelector(selector)
    if (!button) return null
    const { x, y, width, height } = button.getBoundingClientRect()
    return { x: Math.round(x + width / 2), y: Math.round(y + height / 2) }
  }, trigger)
  assert.ok(target, 'the address line opens message details')
  const frame = await run(() => {
    window.messageDetailsFrame = document.querySelector('iframe')
    return Boolean(window.messageDetailsFrame)
  })
  assert.ok(frame)
  for (const type of ['mousePressed', 'mouseReleased']) {
    await wc.debugger.sendCommand('Input.dispatchMouseEvent', {
      type,
      ...target,
      button: 'left',
      clickCount: 1,
    })
  }
  await waitFor(
    () => run((selector) => !!document.querySelector(selector), popup),
    'message details',
  )
  const details = await run((selector) => {
    const panel = document.querySelector(selector)
    const rect = panel.getBoundingClientRect()
    return {
      fields: Object.fromEntries(
        [...panel.querySelectorAll('dt')].map((term) => [
          term.textContent,
          term.nextElementSibling.textContent,
        ]),
      ),
      fits:
        rect.left >= 0 && rect.right <= innerWidth && rect.top >= 0 && rect.bottom <= innerHeight,
    }
  }, popup)
  assert.deepEqual(Object.keys(details.fields), ['From', 'To', 'Cc', 'Bcc', 'Reply-To'])
  assert.match(details.fields.From, /@/)
  assert.match(details.fields.To, /@/)
  assert.equal(details.fields.Cc, 'Copy Recipient cc@example.test')
  assert.equal(details.fields.Bcc, 'bcc@example.test')
  assert.equal(details.fields['Reply-To'], 'reply@example.test')
  assert.ok(details.fits, 'message details fit in the compact reader')

  const press = async (key, code, windowsVirtualKeyCode) => {
    for (const type of ['rawKeyDown', 'keyUp']) {
      await wc.debugger.sendCommand('Input.dispatchKeyEvent', {
        type,
        key,
        code,
        windowsVirtualKeyCode,
      })
    }
  }
  await press('Escape', 'Escape', 27)
  await waitFor(
    () => run((selector) => document.activeElement === document.querySelector(selector), trigger),
    'focus to return to the address line',
  )
  await press(' ', 'Space', 32)
  await waitFor(() => run((selector) => !!document.querySelector(selector), popup), 'keyboard open')
  await press('Escape', 'Escape', 27)
  await waitFor(
    () => run((selector) => !document.querySelector(selector), popup),
    'details to close',
  )
  assert.ok(
    await run(
      () =>
        document.querySelector('iframe') === window.messageDetailsFrame &&
        window.messageDetailsFrame.checkVisibility(),
    ),
    'opening and closing details keeps the original message body visible',
  )
  console.log('Message details passed with native mouse and keyboard input')
}

async function checkComposerKeyboard(wc, run) {
  const press = async (key, windowsVirtualKeyCode, modifiers = 0) => {
    for (const type of ['rawKeyDown', 'keyUp']) {
      await wc.debugger.sendCommand('Input.dispatchKeyEvent', {
        type,
        key,
        windowsVirtualKeyCode,
        modifiers,
      })
    }
  }
  const focus = () => run(() => document.activeElement.name || document.activeElement.ariaLabel)
  const expectFocus = (field) => waitFor(async () => (await focus()) === field, `${field} focus`)
  await run(() => document.querySelector('[aria-label="Threads"]').focus())
  await press('c', 67)
  await expectFocus('to')
  await wc.debugger.sendCommand('Input.insertText', { text: 'keyboard@example.test' })
  await press('Tab', 9)
  await expectFocus('subject')
  assert.equal(await run(() => document.querySelector('[name="to"]').value), '')
  assert.equal(
    await run(() => Boolean(document.querySelector('[aria-label="Remove keyboard@example.test"]'))),
    true,
  )
  await press('Tab', 9)
  await expectFocus('Message body')
  await press('Tab', 9, 8)
  await expectFocus('subject')
  await press('Tab', 9, 8)
  await expectFocus('to')

  const commandShift = 4 | 8
  await press('B', 66, commandShift)
  await expectFocus('bcc')
  await press('Tab', 9, 8)
  await expectFocus('cc')
  await press('O', 79, commandShift)
  await expectFocus('to')
  await press('Tab', 9)
  await expectFocus('cc')
  await press('Tab', 9)
  await expectFocus('bcc')
  await press('Tab', 9)
  await expectFocus('subject')
  await press('E', 69, commandShift)
  await expectFocus('from')
  await press('Backspace', 8, 4)
  // The Cancel button can receive focus before the new modal layer owns Escape.
  await waitFor(
    () =>
      run(() => {
        const [composer] = document.querySelectorAll('[role="dialog"]')
        return (
          document.activeElement.textContent === 'Cancel' &&
          composer?.style.pointerEvents === 'none'
        )
      }),
    'discard confirmation focus and active modal layer',
  )
  await press('Escape', 27)
  await expectFocus('from')
  await press('S', 83, commandShift)
  await expectFocus('subject')
  await press('C', 67, commandShift)
  await expectFocus('cc')
  await press('M', 77, commandShift)
  await expectFocus('Message body')
  await wc.debugger.sendCommand('Input.insertText', { text: 'Draft saved from the backdrop' })
  assert.equal(await run(() => document.elementFromPoint(10, 10)?.dataset.slot), 'dialog-overlay')
  for (const type of ['mousePressed', 'mouseReleased']) {
    await wc.debugger.sendCommand('Input.dispatchMouseEvent', {
      type,
      x: 10,
      y: 10,
      button: 'left',
      clickCount: 1,
    })
  }
  await waitFor(
    () => run(() => !document.querySelector('[role="dialog"]')),
    'backdrop click to minimise the composer',
  )
  await run(() =>
    [...document.querySelectorAll('button')]
      .find((button) => button.textContent.trim() === 'Resume draft')
      .click(),
  )
  await expectFocus('Message body')
  assert.equal(await run(() => document.activeElement.textContent), 'Draft saved from the backdrop')
  await press('Escape', 27)
  await waitFor(
    () => run(() => !document.querySelector('[role="dialog"]')),
    'saved composer to close',
  )
  console.log('Composer keyboard navigation and backdrop dismissal passed with native input')
}

async function main() {
  let server
  let win
  let exitCode = 0
  const heldImage = Promise.withResolvers()
  try {
    server = await startReaderServer(heldImage.promise)
    await app.whenReady()
    nativeTheme.themeSource = 'dark'
    protectRemoteImageRequests(session.defaultSession)
    win = new BrowserWindow({
      show: false,
      width: 1360,
      height: 900,
      webPreferences: {
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        // Exercise foreground reader behavior in a hidden test window.
        backgroundThrottling: false,
      },
    })
    const wc = win.webContents
    wc.debugger.attach('1.3')
    const run = (fn, ...args) =>
      wc.executeJavaScript(`(${fn})(${args.map((arg) => JSON.stringify(arg)).join(',')})`)
    const origin = server.resolvedUrls.local[0]
    await win.loadURL(new URL('?fixture=html-reader', origin).href)

    const selectThread = async (number, marker) => {
      const selector = `[data-thread-id="thread-${number}"]`
      await waitFor(() => run((value) => !!document.querySelector(value), selector), selector)
      await run((value) => document.querySelector(value).click(), selector)
      await waitFor(
        () =>
          run(
            (value) =>
              [...document.querySelectorAll('iframe')].some(
                (frame) =>
                  !frame.closest('[inert]') && frame.contentDocument?.getElementById(value),
              ),
            marker,
          ),
        marker,
      )
    }
    const firstVisibleFrame = async (number, marker, outgoingMarker) => {
      const selector = `[data-thread-id="thread-${number}"]`
      await waitFor(() => run((value) => !!document.querySelector(value), selector), selector)
      return run(
        (row, id, outgoingId) =>
          new Promise((resolve) => {
            const deadline = performance.now() + 5000
            let emptyFrames = 0
            const sample = () => {
              const visibleFrames = [...document.querySelectorAll('iframe')].filter((frame) => {
                const rect = frame.getBoundingClientRect()
                const reader = frame.closest('.overflow-y-auto')?.getBoundingClientRect()
                return (
                  reader &&
                  rect.height > 0 &&
                  rect.top < Math.min(innerHeight, reader.bottom) &&
                  rect.bottom > Math.max(0, reader.top) &&
                  frame.checkVisibility({ opacityProperty: true, visibilityProperty: true })
                )
              })
              const frame = visibleFrames.find((candidate) =>
                candidate.contentDocument?.getElementById(id),
              )
              if (frame) {
                const doc = frame.contentDocument
                resolve({
                  height: frame.offsetHeight,
                  viewport: doc.documentElement.clientHeight,
                  bottom: doc.getElementById(id).getBoundingClientRect().bottom,
                  canvas: getComputedStyle(doc.documentElement).backgroundColor,
                  overflowY: getComputedStyle(doc.documentElement).overflowY,
                  imageComplete: doc.getElementById('probe-held')?.complete,
                  emptyFrames,
                })
              } else if (performance.now() < deadline) {
                if (
                  outgoingId &&
                  !visibleFrames.some((candidate) =>
                    candidate.contentDocument?.getElementById(outgoingId),
                  )
                )
                  emptyFrames++
                requestAnimationFrame(sample)
              } else {
                resolve(null)
              }
            }
            document.querySelector(row).click()
            requestAnimationFrame(sample)
          }),
        selector,
        marker,
        outgoingMarker ?? null,
      )
    }
    const measure = (marker, width) =>
      run(
        (id, requestedWidth) => {
          const frame = [...document.querySelectorAll('iframe')].find((candidate) =>
            candidate.contentDocument?.getElementById(id),
          )
          if (requestedWidth) frame.style.width = `${requestedWidth + 2}px`
          const doc = frame.contentDocument
          const root = doc.documentElement
          const target = doc.getElementById(id)
          const range = doc.createRange()
          range.selectNodeContents(target)
          const image = doc.getElementById('probe-cid')
          const oversized = doc.getElementById('probe-oversized')
          const targetRect = target.getBoundingClientRect()
          return {
            lines: new Set(
              [...range.getClientRects()].filter((rect) => rect.width > 0).map((rect) => rect.top),
            ).size,
            width: root.clientWidth,
            overflow: root.scrollWidth - root.clientWidth,
            zoom: Number(getComputedStyle(root).zoom),
            height: frame.offsetHeight,
            color:
              doc.getElementById('probe-first') &&
              getComputedStyle(doc.getElementById('probe-first')).color,
            responsive:
              doc.getElementById('probe-responsive') &&
              getComputedStyle(doc.getElementById('probe-responsive')).display,
            image: image && [image.naturalWidth, image.naturalHeight, image.width, image.height],
            oversized: oversized && [oversized.width, oversized.height],
            endWidth: target.closest('table')?.offsetWidth,
            targetVisible: targetRect.left >= -1 && targetRect.right <= root.clientWidth + 1,
            hasHorizontalControl: frame.parentElement.parentElement.textContent.includes(
              'Scroll message horizontally',
            ),
            finalLineVisible:
              (doc.getElementById('probe-last')?.getBoundingClientRect().bottom ?? 0) <=
              root.clientHeight,
            nativeVertical: getComputedStyle(root).overflowY,
          }
        },
        marker,
        width,
      )

    await waitFor(
      () => run(() => !!document.querySelector('[data-thread-id="thread-7"]')),
      'mailbox rows',
    )
    await run(() => {
      window.compactList = document.querySelector('[role="listbox"]')
      window.compactRow = document.querySelector('[data-thread-id="thread-7"]')
    })
    win.setContentSize(640, 560)
    await waitFor(
      () => run(() => window.innerWidth === 640 && !document.querySelector('iframe')),
      '640px window with the split reader closed',
    )
    assert.deepEqual(
      await run(() => {
        const list = document.querySelector('[role="listbox"]')
        const sidebar = document.querySelector('[data-slot="sidebar"]')
        return [
          list === window.compactList,
          Math.round(
            list.closest('[data-thread-viewport]').getBoundingClientRect().width +
              sidebar.getBoundingClientRect().width,
          ),
          document.querySelector('[data-slot="resizable-handle"]').offsetWidth === 0,
        ]
      }),
      [true, 640, true],
      'the list uses all mailbox space at the narrow window width',
    )
    await selectThread(7, 'probe-theme')
    await checkMessageDetails(wc, run)
    await waitFor(
      () => run(() => document.querySelector('[aria-label="Back to mailbox"]')?.offsetWidth > 0),
      'compact reader Back button',
    )
    assert.equal(
      await run(() =>
        Math.round(document.querySelector('[data-focus-reader]').getBoundingClientRect().width),
      ),
      640,
      'the compact reader fills the window',
    )
    await run(() => document.querySelector('[aria-label="Back to mailbox"]').click())
    assert.equal(
      await run(
        () =>
          document.activeElement === window.compactList &&
          document.querySelector('[data-thread-id="thread-7"]') === window.compactRow,
      ),
      true,
      'Back restores the same list and row with keyboard focus',
    )

    const pressCompactKey = async (key, windowsVirtualKeyCode) => {
      for (const type of ['rawKeyDown', 'keyUp']) {
        await wc.debugger.sendCommand('Input.dispatchKeyEvent', {
          type,
          key,
          windowsVirtualKeyCode,
        })
      }
    }
    await pressCompactKey('ArrowUp', 38)
    assert.equal(
      await run(() => !document.querySelector('[data-focus-reader]')),
      true,
      'arrow selection stays in the compact list',
    )
    await pressCompactKey('ArrowDown', 40)
    await pressCompactKey('Enter', 13)
    await waitFor(
      () => run(() => !!document.querySelector('[data-focus-reader] iframe')),
      'Enter opens the selected compact thread',
    )
    await run(() => {
      const frame = document.querySelector('[data-focus-reader] iframe')
      window.compactFrame = frame
      frame.focus()
    })
    win.setContentSize(1000, 760)
    await waitFor(
      () => run(() => document.querySelector('[data-slot="resizable-handle"]').offsetWidth > 0),
      'the split returns at 1000px',
    )
    win.setContentSize(999, 760)
    await waitFor(
      () => run(() => document.querySelector('[data-slot="resizable-handle"]').offsetWidth === 0),
      'the split hides at 999px',
    )
    assert.equal(
      await run(() => document.querySelector('[data-focus-reader] iframe') === window.compactFrame),
      true,
      'the open message keeps its iframe as the layout changes',
    )
    await pressCompactKey('Escape', 27)
    await waitFor(
      () =>
        run(
          () =>
            !document.querySelector('[data-focus-reader]') &&
            document.activeElement === window.compactList,
        ),
      'Escape from HTML returns to the compact list',
    )
    win.setContentSize(1360, 900)
    await waitFor(
      () => run(() => document.querySelector('[data-slot="resizable-handle"]').offsetWidth > 0),
      'wide window',
    )
    await selectThread(7, 'probe-theme')
    const messageColors = () =>
      run(() => {
        const doc = document.querySelector('iframe').contentDocument
        const message = doc.getElementById('probe-theme')
        const card = doc.getElementById('probe-dark-card')
        const cell = doc.getElementById('probe-light-cell')
        const gradient = doc.getElementById('probe-gradient')
        const variable = doc.getElementById('probe-variable')
        const translucent = doc.getElementById('probe-translucent')
        return {
          darkMedia: doc.defaultView.matchMedia('(prefers-color-scheme: dark)').matches,
          foreground: getComputedStyle(message).color,
          canvas: getComputedStyle(doc.documentElement).backgroundColor,
          card: [getComputedStyle(card).color, getComputedStyle(card).backgroundColor],
          cell: [
            getComputedStyle(cell.firstElementChild).color,
            getComputedStyle(cell).backgroundColor,
          ],
          gradient: [getComputedStyle(gradient).color, getComputedStyle(gradient).backgroundImage],
          variable: [variable.getAttribute('style'), getComputedStyle(variable).backgroundColor],
          translucent: getComputedStyle(translucent).color,
        }
      })
    const lightColors = {
      darkMedia: false,
      foreground: 'rgb(31, 31, 31)',
      canvas: 'rgb(255, 255, 255)',
      card: ['rgb(255, 255, 255)', 'rgb(34, 34, 34)'],
      cell: ['rgb(17, 17, 17)', 'rgb(255, 255, 255)'],
      gradient: ['rgb(34, 34, 34)', 'linear-gradient(rgb(255, 255, 255), rgb(238, 238, 238))'],
      variable: ['--card:#fff;background:var(--card);color:#222', 'rgb(255, 255, 255)'],
      translucent: 'rgba(0, 0, 0, 0.8)',
    }
    await waitFor(() => run(() => document.documentElement.classList.contains('dark')), 'dark UI')
    const defaultColors = await messageColors()
    assert.equal(defaultColors.canvas, 'rgb(29, 29, 29)', 'HTML opens dark by default')
    await run(() => {
      document.querySelector('iframe').contentDocument.body.dataset.themeContinuity = 'original'
    })
    nativeTheme.themeSource = 'light'
    await waitFor(() => run(() => !document.documentElement.classList.contains('dark')), 'light UI')
    assert.deepEqual(await messageColors(), defaultColors, 'message stays dark in the light UI')
    assert.equal(
      await run(
        () => document.querySelector('iframe').contentDocument.body.dataset.themeContinuity,
      ),
      'original',
      'theme changes keep the message document',
    )

    const appearanceButton = (label) =>
      run((name) => Boolean(document.querySelector(`button[aria-label="${name}"]`)), label)
    await waitFor(() => appearanceButton('Show original colors'), 'default dark appearance button')
    await run(() => document.querySelector('button[aria-label="Show original colors"]').click())
    assert.deepEqual(await messageColors(), lightColors, 'original colors are available on demand')
    const beforeAppearance = await run(() => {
      const button = document.querySelector('button[aria-label="Try dark background"]')
      const frame = document.querySelector('iframe')
      window.appearanceFrame = frame
      window.appearanceDocument = frame.contentDocument
      button.focus()
      return frame.getBoundingClientRect().top
    })
    for (const type of ['rawKeyDown', 'keyUp']) {
      await wc.debugger.sendCommand('Input.dispatchKeyEvent', {
        type,
        key: ' ',
        code: 'Space',
        windowsVirtualKeyCode: 32,
      })
    }
    await waitFor(() => appearanceButton('Show original colors'), 'keyboard dark appearance')
    const adjusted = await messageColors()
    assert.equal(adjusted.darkMedia, false, 'partial sender dark style stays inactive')
    assert.equal(adjusted.canvas, 'rgb(29, 29, 29)')
    assert.equal(adjusted.foreground, 'rgb(226, 226, 226)')
    assert.deepEqual(adjusted.card, lightColors.card, 'already dark colors are preserved')
    assert.deepEqual(adjusted.cell, ['rgb(226, 226, 226)', 'rgb(33, 33, 33)'])
    assert.equal(
      adjusted.variable[1],
      'rgb(33, 33, 33)',
      'CSS variables take part in the dark palette',
    )
    assert.equal(adjusted.translucent, 'rgba(226, 226, 226, 0.8)', 'translucent ink stays readable')
    assert.deepEqual(
      adjusted.gradient,
      lightColors.gradient,
      'image-backed surfaces keep their colors',
    )
    const appearancePixel = await run(() => {
      const rect = document.querySelector('iframe').getBoundingClientRect()
      return { x: Math.round(rect.right - 24), y: Math.round(rect.top + 8), width: 1, height: 1 }
    })
    await waitFor(async () => {
      const painted = (await wc.capturePage(appearancePixel)).toBitmap()
      return painted[0] === 29 && painted[1] === 29 && painted[2] === 29
    }, 'the dark canvas is painted')
    assert.deepEqual(
      await run(() => {
        const button = document.querySelector('button[aria-label="Show original colors"]')
        const frame = document.querySelector('iframe')
        return [
          document.activeElement === button,
          frame === window.appearanceFrame && frame.contentDocument === window.appearanceDocument,
          frame.getBoundingClientRect().top,
        ]
      }),
      [true, true, beforeAppearance],
      'the inline header action preserves focus, document, and body position',
    )
    await run(() => {
      const rootStyle = document.querySelector('iframe').contentDocument.documentElement.style
      rootStyle.setProperty('zoom', '1', 'important')
      document.querySelector('button[aria-label="Show original colors"]').click()
    })
    assert.deepEqual(await messageColors(), lightColors, 'original colors are restored')
    assert.deepEqual(
      await run(() => {
        const rootStyle = document.querySelector('iframe').contentDocument.documentElement.style
        const zoom = [rootStyle.getPropertyValue('zoom'), rootStyle.getPropertyPriority('zoom')]
        rootStyle.removeProperty('zoom')
        return zoom
      }),
      ['1', 'important'],
      'restoration keeps frame sizing updates made while dark appearance was active',
    )
    await waitFor(async () => {
      const painted = (await wc.capturePage(appearancePixel)).toBitmap()
      return painted[0] === 255 && painted[1] === 255 && painted[2] === 255
    }, 'the original canvas is painted')
    assert.equal(
      await run(() =>
        document
          .querySelector('iframe')
          .contentDocument.getElementById('probe-light-cell')
          .style.getPropertyPriority('color'),
      ),
      'important',
      'restoration keeps sender declarations and priorities',
    )

    await selectThread(1, 'probe-status')
    await run(() => document.querySelector('button[aria-label="Show original colors"]').click())
    const at623 = await measure('probe-status', 623)
    const at320 = await measure('probe-status', 320)
    assert.deepEqual(
      [at623.lines, at320.lines, at623.color, at623.responsive, at320.responsive],
      [1, 1, 'rgb(12, 34, 56)', 'inline-block', 'block'],
      'short table headings and sender head styles at both widths',
    )
    await waitFor(async () => (await measure('probe-status')).image?.[0] === 2, 'CID image')
    const images = await measure('probe-status')
    assert.deepEqual(images.image, [2, 1, 120, 120])
    assert.ok(images.oversized[0] < images.width)
    assert.ok(Math.abs(images.oversized[0] / 2 - images.oversized[1]) <= 1)
    assert.equal(
      await run(() =>
        [...document.querySelectorAll('button')].some(
          (button) => button.textContent === 'Scroll message horizontally',
        ),
      ),
      false,
      'fitting mail adds no scroll control',
    )
    await run(() => {
      const older = [...document.querySelectorAll('button')].find((button) =>
        button.textContent.includes('Sending over the updated layout.'),
      )
      window.olderMessage = older
      older.click()
      older.click()
    })
    await waitFor(
      () =>
        run(() =>
          [...document.querySelectorAll('iframe')].some(
            (frame) =>
              frame.contentDocument?.getElementById('probe-older') && frame.offsetWidth === 0,
          ),
        ),
      'older HTML parses while collapsed',
    )
    win.setContentSize(1000, 800)
    await run(() => window.olderMessage.click())
    await waitFor(
      () =>
        run(() =>
          [...document.querySelectorAll('iframe')].some(
            (frame) =>
              frame.contentDocument?.getElementById('probe-older') &&
              frame.offsetWidth > 0 &&
              getComputedStyle(frame).visibility === 'visible',
          ),
        ),
      'older HTML measures when reopened at a new width',
    )
    win.setContentSize(1360, 900)

    await run(() => {
      const frame = [...document.querySelectorAll('iframe')].find((item) =>
        item.contentDocument?.getElementById('probe-status'),
      )
      frame.style.removeProperty('width')
      frame.contentDocument.body.dataset.continuity = 'original'
      frame.focus()
      frame.contentDocument
        .getSelection()
        .selectAllChildren(frame.contentDocument.getElementById('probe-first'))
    })
    await run(async () => (await import('/src/lib/amc.ts')).getAmc().syncNow())
    win.setContentSize(1000, 780)
    await delay(100)
    assert.equal(
      await run(() =>
        [...document.querySelectorAll('iframe')].some(
          (frame) =>
            frame.contentDocument?.body.dataset.continuity === 'original' &&
            document.activeElement === frame &&
            frame.contentDocument.getSelection().toString() === 'First line',
        ),
      ),
      true,
      'refresh and resize keep the iframe document, focus, and text selection',
    )
    const narrow = await measure('probe-status')
    const narrowReaderWidth = narrow.width
    assert.ok(
      narrowReaderWidth > 0 && narrowReaderWidth < 623,
      `narrow reader: ${narrowReaderWidth}px`,
    )
    assert.equal(narrow.lines, 1)
    win.setContentSize(1360, 900)

    await selectThread(2, 'probe-job')
    for (const width of [320, 623]) {
      const table = await measure('probe-job', width)
      assert.equal(table.overflow, 0, `long table token fits at ${width}px`)
      assert.ok(table.lines > 1)
      assert.ok((await measure('probe-prose')).lines > 1)
    }

    for (const thread of [3, 4]) {
      await selectThread(thread, 'probe-end')
      for (const width of [undefined, 623, 320, 900, 623]) {
        if (width) await measure('probe-end', width)
        const fitted = await waitFor(
          async () => {
            const frame = await measure('probe-end')
            return (
              (!width || frame.width === width) &&
              frame.zoom < 1 === frame.width < 780 &&
              frame.overflow === 0 &&
              !frame.hasHorizontalControl &&
              frame.finalLineVisible &&
              frame
            )
          },
          `thread ${thread} to fit at ${width ? `${width}px` : 'the reading pane width'}`,
        )
        assert.equal(fitted.endWidth, 780, 'fixed-width table keeps its layout')
        assert.ok(fitted.targetVisible, 'final column fits without scrolling')
        assert.equal((await measure('probe-code')).lines, 1, 'preformatted text keeps its line')
      }
    }

    const firstFeedback = await firstVisibleFrame(5, 'probe-feedback')
    assert.equal(firstFeedback?.overflowY, 'auto', 'height feedback settles before first reveal')
    const settled = await waitFor(async () => {
      const frame = await measure('probe-feedback')
      return frame.nativeVertical === 'auto' && frame.height
    }, 'bounded viewport for height feedback')
    await delay(200)
    assert.equal((await measure('probe-feedback')).height, settled, 'height feedback stops')

    await selectThread(6, 'probe-images')
    assert.ok(await appearanceButton('Show original colors'), 'a new message uses the dark default')
    assert.deepEqual(requests, { message: 0, parent: 0, missing: 0, held: 0 })
    await run(() => {
      const image = new Image()
      image.src = '/__amc_fixture_image?source=parent'
      document.body.append(image)
    })
    const beforeConsent = (await measure('probe-images')).height
    await run(() =>
      [...document.querySelectorAll('button')]
        .find((button) => button.textContent === 'Load images')
        .click(),
    )
    await waitFor(
      () =>
        run(() =>
          [...document.querySelectorAll('iframe')].some((frame) => {
            const doc = frame.contentDocument
            return (
              doc?.getElementById('probe-remote')?.naturalWidth > 0 &&
              doc.getElementById('probe-missing')?.complete
            )
          }),
        ),
      'allowed image load and failed image settle',
    )
    assert.deepEqual(requests, { message: 1, parent: 0, missing: 1, held: 0 })
    assert.equal(
      await run(
        () =>
          getComputedStyle(document.querySelector('iframe').contentDocument.documentElement)
            .backgroundColor,
      ),
      'rgb(29, 29, 29)',
      'image consent keeps the selected appearance',
    )
    await run(() => document.querySelector('button[aria-label="Show original colors"]').click())
    assert.deepEqual(requests, { message: 1, parent: 0, missing: 1, held: 0 })
    await waitFor(
      async () => (await measure('probe-images')).height > beforeConsent,
      'iframe grows after delayed image load',
    )

    await run(async () => {
      const { setLoadRemoteImagesAutomatically } = await import(
        '/src/data/remote-image-preferences.ts'
      )
      setLoadRemoteImagesAutomatically(true)
    })
    const firstNewsletter = await firstVisibleFrame(8, 'probe-newsletter-end', 'probe-images')
    assert.ok(firstNewsletter, 'newsletter appears with the image response held')
    assert.equal(firstNewsletter.canvas, 'rgb(29, 29, 29)', 'the first visible newsletter is dark')
    assert.equal(firstNewsletter.emptyFrames, 0, 'an immediate HTML switch keeps a body visible')
    assert.equal(firstNewsletter.imageComplete, false)
    assert.ok(
      firstNewsletter.bottom <= firstNewsletter.viewport,
      `first visible newsletter fits (${firstNewsletter.bottom}px in ${firstNewsletter.viewport}px)`,
    )
    await waitFor(() => requests.held > 0, 'held image request')
    await run(() => {
      window.firstNewsletterFrame = document.querySelector('iframe')
    })
    nativeTheme.themeSource = 'dark'
    await waitFor(() => run(() => document.documentElement.classList.contains('dark')), 'dark UI')
    await selectThread(7, 'probe-theme')
    const bodyPixel = await waitFor(
      () =>
        run(() => {
          const frame = document.querySelector('iframe')
          if (getComputedStyle(frame).visibility !== 'visible') return null
          const rect = frame.getBoundingClientRect()
          return {
            x: Math.round(rect.right - 24),
            y: Math.round(rect.top + 8),
            width: 1,
            height: 1,
          }
        }),
      'visible outgoing body',
    )
    const captureBodyPixel = async () => [
      ...(await wc.capturePage(bodyPixel)).toBitmap().subarray(0, 4),
    ]
    assert.deepEqual(await captureBodyPixel(), [29, 29, 29, 255], 'outgoing HTML paints dark')
    await run(async () => {
      const api = (await import('/src/lib/amc.ts')).getAmc()
      const load = api.messageHtml
      const observer = new MutationObserver(() => {
        const frame = [...document.querySelectorAll('[inert] iframe[data-reader-html-ready]')].find(
          (candidate) => candidate.contentDocument?.getElementById('probe-newsletter-end'),
        )
        if (frame) {
          window.stagedNewsletter = frame
          window.stagedNewsletterDocument = frame.contentDocument
        }
      })
      observer.observe(document.body, {
        subtree: true,
        attributes: true,
        attributeFilter: ['data-reader-html-ready'],
      })
      api.messageHtml = async (id) => {
        if (id === 'thread-8:latest') {
          await new Promise((resolve) => {
            window.releaseNewsletterBody = resolve
          })
        }
        return load(id)
      }
      window.restoreMessageHtml = () => {
        api.messageHtml = load
      }
      window.stopWatchingNewsletter = () => observer.disconnect()
    })
    const openingNewsletter = firstVisibleFrame(8, 'probe-newsletter-end', 'probe-theme')
    await waitFor(() => run(() => !!window.releaseNewsletterBody), 'incoming HTML request')
    assert.ok(
      await run(() => {
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'r', bubbles: true }))
        return !document.querySelector('[aria-label="Reply"]')
      }),
      'Reply is unavailable while the selected body is hidden',
    )
    await run(
      () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
    )
    const pendingPixel = await captureBodyPixel()
    assert.equal(await run(() => !!document.querySelector('[role="dialog"]')), false)
    await run(() => {
      window.restoreMessageHtml()
      window.releaseNewsletterBody()
    })
    const reopenedNewsletter = await openingNewsletter
    assert.deepEqual(
      pendingPixel,
      [29, 29, 29, 255],
      'outgoing body stays painted during an HTML read',
    )
    assert.equal(
      reopenedNewsletter?.emptyFrames,
      0,
      'switching HTML threads never exposes an empty body frame',
    )
    assert.ok(
      await run(() => {
        window.stopWatchingNewsletter()
        const frame = document.querySelector('iframe')
        return (
          frame === window.stagedNewsletter &&
          frame?.contentDocument === window.stagedNewsletterDocument
        )
      }),
      'promotion keeps the staged iframe and its parsed document',
    )
    const { bottom: reopenedBottom, ...reopenedGeometry } = reopenedNewsletter
    const { bottom: initialBottom, ...initialGeometry } = firstNewsletter
    assert.deepEqual(reopenedGeometry, initialGeometry, 'reopened newsletter fits before release')
    assert.ok(
      reopenedBottom <= reopenedNewsletter.viewport &&
        Math.abs(reopenedBottom - initialBottom) <= 1,
      'the last line stays visible at the same position to within a CSS pixel',
    )
    assert.equal(await run(() => window.firstNewsletterFrame.isConnected), false)
    await waitFor(() => requests.held === 2, 'held image request from reopened newsletter')
    heldImage.resolve()
    await waitFor(
      () => run(() => document.querySelector('iframe')?.contentDocument?.readyState === 'complete'),
      'newsletter image completion',
    )
    await run(
      () =>
        new Promise((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    )
    assert.ok(
      Math.abs((await measure('probe-newsletter-end')).height - firstNewsletter.height) <= 1,
    )

    await run(async () => {
      const api = (await import('/src/lib/amc.ts')).getAmc()
      const load = api.messageHtml
      api.messageHtml = async (id) => {
        if (id === 'thread-7:latest') {
          await new Promise((resolve) => {
            window.releaseWorkshopBody = resolve
          })
        }
        return load(id)
      }
      window.restoreWorkshopBody = () => {
        api.messageHtml = load
      }
      document.querySelector('[data-thread-id="thread-7"]').click()
    })
    await waitFor(() => run(() => !!window.releaseWorkshopBody), 'staged workshop body read')
    await run(() => document.querySelector('[role="listbox"]').focus())
    await selectThread(6, 'probe-images')
    await run(() => {
      window.restoreWorkshopBody()
      window.releaseWorkshopBody()
    })
    await run(
      () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
    )
    assert.ok(
      await run(() => {
        const frame = document.querySelector('iframe')
        return (
          !!frame?.contentDocument?.getElementById('probe-images') &&
          !frame.closest('[inert]') &&
          document.activeElement.getAttribute('role') === 'listbox'
        )
      }),
      'a superseded HTML reply keeps the current reader and list focus',
    )

    await run(async () => {
      const api = (await import('/src/lib/amc.ts')).getAmc()
      const load = api.messageHtml
      api.messageHtml = async (id) => {
        if (id === 'thread-7:latest') throw new Error('Synthetic HTML read failed')
        return load(id)
      }
      window.restoreWorkshopBody = () => {
        api.messageHtml = load
      }
      document.querySelector('[data-thread-id="thread-7"]').click()
    })
    await waitFor(
      () =>
        run(
          () =>
            !document.querySelector('iframe') &&
            document.querySelector('h1')?.textContent === 'Notes from the type review' &&
            !document.querySelector('button[aria-label="Try dark background"]') &&
            !document.querySelector('button[aria-label="Show original colors"]') &&
            [...document.querySelectorAll('button[aria-expanded="true"][aria-controls]')].some(
              (header) => {
                const body = document.getElementById(header.getAttribute('aria-controls'))
                return (
                  body?.textContent.includes('The captions are set at the new size.') &&
                  body.querySelector('button')?.textContent ===
                    'Could not load formatted email. Retry'
                )
              },
            ),
        ),
      'selected message text replaces the outgoing reader after an HTML read fails',
    )
    await run(() => {
      window.restoreWorkshopBody()
      const retry = [...document.querySelectorAll('button')].find(
        (button) => button.textContent === 'Could not load formatted email. Retry',
      )
      retry.click()
    })
    await waitFor(
      () =>
        run(
          () => !!document.querySelector('iframe')?.contentDocument?.getElementById('probe-theme'),
        ),
      'retry restores the formatted message',
    )
    await selectThread(8, 'probe-newsletter-end')
    console.log('HTML handoff kept the dark body painted with 0 empty animation-frame samples')

    console.log(
      `HTML reader verified in Chromium ${process.versions.chrome}, split-view iframe ${narrowReaderWidth}px`,
    )

    const sidebarLayout = () =>
      run(() => {
        const sidebar = document.querySelector('[data-slot="sidebar-content"]')
        const viewport = sidebar.querySelector('[data-radix-scroll-area-viewport]') ?? sidebar
        const inbox = sidebar.querySelector('[aria-current="page"]')
        return {
          width: inbox.getBoundingClientRect().width,
          overflow: viewport.scrollHeight - viewport.clientHeight,
          overlay: !!sidebar.querySelector('[data-slot="scroll-area-thumb"]'),
          focusPreserved: document.activeElement === inbox,
        }
      })
    await waitFor(() => run(() => !!document.querySelector('[aria-current="page"]')), 'sidebar')
    win.setContentSize(1360, 760)
    await waitFor(() => run(() => innerHeight === 760), 'short window')
    const closed = await sidebarLayout()
    assert.equal(closed.overflow, 0, 'folders fit with Triage closed')
    assert.equal(closed.overlay, false)
    const collapsedHeaderGap = await run(() => {
      const headers = [...document.querySelectorAll('[data-sidebar="group-label"]')]
      const triage = headers.find((header) => header.textContent === 'Triage')
      const labels = headers.find((header) => header.textContent === 'Labels')
      return labels.getBoundingClientRect().top - triage.getBoundingClientRect().bottom
    })
    assert.equal(collapsedHeaderGap, 8, 'collapsed Triage and Labels have a compact gap')
    await run(() => {
      const sidebar = document.querySelector('[data-slot="sidebar-content"]')
      sidebar.querySelector('[aria-current="page"]').focus()
      const triage = [...sidebar.querySelectorAll('button')].find(
        (button) => button.textContent.trim() === 'Triage',
      )
      triage.click()
    })
    await waitFor(async () => (await sidebarLayout()).overflow > 0, 'sidebar overflow')
    const open = await sidebarLayout()
    assert.equal(open.width, closed.width, 'overflow keeps the Inbox button the same width')
    assert.ok(open.focusPreserved)
    await waitFor(async () => (await sidebarLayout()).overlay, 'sidebar overlay thumb')
    const wheelTarget = await run(() => {
      const viewport = document.querySelector('[data-radix-scroll-area-viewport]')
      const bounds = viewport.getBoundingClientRect()
      return { x: Math.round(bounds.left + 40), y: Math.round(bounds.top + 40) }
    })
    await wc.debugger.sendCommand('Input.dispatchMouseEvent', {
      type: 'mouseWheel',
      ...wheelTarget,
      deltaX: 0,
      deltaY: 200,
    })
    await waitFor(
      () => run(() => document.querySelector('[data-radix-scroll-area-viewport]').scrollTop > 0),
      'native sidebar wheel scrolling',
    )
    console.log(`Sidebar row kept its ${open.width}px width when Triage overflowed`)
    await checkComposerKeyboard(wc, run)

    assert.equal(
      await run(() => {
        const frame = document.querySelector('iframe[title="Message"]')
        frame.focus()
        return document.activeElement === frame
      }),
      true,
      'the HTML message has keyboard focus',
    )
    await wc.debugger.sendCommand('Input.dispatchKeyEvent', {
      type: 'keyDown',
      key: 'r',
      code: 'KeyR',
      text: 'r',
    })
    await wc.debugger.sendCommand('Input.dispatchKeyEvent', {
      type: 'keyUp',
      key: 'r',
      code: 'KeyR',
    })
    await waitFor(
      () =>
        run(
          () =>
            document.querySelector(
              '[role="dialog"] input[value="Re: Samples from the paper mill"]',
            ) !== null,
        ),
      'reply composer for the focused HTML message',
    )
    assert.equal(await run(() => document.activeElement.ariaLabel), 'Message body')
    await checkTriageReader(win, { origin, run, waitFor })
  } catch (error) {
    console.error(error)
    exitCode = 1
  } finally {
    heldImage.resolve()
    win?.destroy()
    await server?.close()
    await rm(profile, { recursive: true })
    app.exit(exitCode)
  }
}

void main()
