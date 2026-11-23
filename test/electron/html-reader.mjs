import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { app, BrowserWindow, session } from 'electron'
import { protectRemoteImageRequests } from '../../apps/desktop/src/main/message-image-requests.ts'
import { requests, startReaderServer } from './html-reader-server.mjs'

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

async function main() {
  let server
  let win
  let exitCode = 0
  try {
    server = await startReaderServer()
    await app.whenReady()
    protectRemoteImageRequests(session.defaultSession)
    win = new BrowserWindow({
      show: false,
      width: 1360,
      height: 900,
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
    })
    const wc = win.webContents
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
              [...document.querySelectorAll('iframe')].some((frame) =>
                frame.contentDocument?.getElementById(value),
              ),
            marker,
          ),
        marker,
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
            hasHorizontalControl: frame.parentElement.textContent.includes(
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

    await selectThread(1, 'probe-status')
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
    await run(() =>
      [...document.querySelectorAll('button')]
        .find((button) => button.textContent.includes('Sending over the updated layout.'))
        .click(),
    )
    await waitFor(
      () =>
        run(() =>
          [...document.querySelectorAll('iframe')].some((frame) =>
            frame.contentDocument?.getElementById('probe-older'),
          ),
        ),
      'older HTML message in the same thread',
    )

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
    win.setContentSize(900, 780)
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
        await delay(120)
        const fitted = await measure('probe-end')
        assert.equal(fitted.overflow, 0, `thread ${thread} at ${fitted.width}px`)
        assert.equal(fitted.endWidth, 780, 'fixed-width table keeps its layout')
        assert.equal(fitted.zoom < 1, fitted.width < 780, 'scale only when needed')
        assert.equal(fitted.hasHorizontalControl, false)
        assert.ok(fitted.targetVisible, 'final column fits without scrolling')
        assert.ok(fitted.finalLineVisible, 'last line fits in the measured frame height')
        assert.equal((await measure('probe-code')).lines, 1, 'preformatted text keeps its line')
      }
    }

    await selectThread(5, 'probe-feedback')
    const settled = await waitFor(async () => {
      const frame = await measure('probe-feedback')
      return frame.nativeVertical === 'auto' && frame.height
    }, 'bounded viewport for height feedback')
    await delay(200)
    assert.equal((await measure('probe-feedback')).height, settled, 'height feedback stops')

    await selectThread(6, 'probe-images')
    assert.deepEqual(requests, { message: 0, parent: 0, missing: 0 })
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
    assert.deepEqual(requests, { message: 1, parent: 0, missing: 1 })
    await waitFor(
      async () => (await measure('probe-images')).height > beforeConsent,
      'iframe grows after delayed image load',
    )

    console.log(
      `HTML reader verified in Chromium ${process.versions.chrome}, minimum-window iframe ${narrowReaderWidth}px`,
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
  } catch (error) {
    console.error(error)
    exitCode = 1
  } finally {
    win?.destroy()
    await server?.close()
    await rm(profile, { recursive: true })
    app.exit(exitCode)
  }
}

void main()
