import { EventEmitter } from 'node:events'
import type { BrowserWindow } from 'electron'
import { expect, it, vi } from 'vitest'
import { loadRenderer } from './renderer-load'

function startRenderer() {
  const webContents = new EventEmitter()
  const window = { webContents, isDestroyed: () => false } as unknown as BrowserWindow
  const load = vi.fn().mockResolvedValue(undefined)
  const showError = vi.fn().mockResolvedValue(undefined)
  loadRenderer(window, load, showError)
  const fail = (code = -6, isMainFrame = true) =>
    webContents.emit(
      'did-fail-load',
      {},
      code,
      'ERR_FILE_NOT_FOUND',
      'file:///index.html',
      isMainFrame,
    )
  return { load, showError, fail }
}

it('retries a main-frame load failure once and offers recovery for a second failure', async () => {
  const { load, showError, fail } = startRenderer()
  expect(load).toHaveBeenCalledOnce()
  fail()
  await new Promise<void>((resolve) => setImmediate(resolve))
  expect(load).toHaveBeenCalledTimes(2)
  expect(showError).not.toHaveBeenCalled()
  fail()
  fail()
  expect(load).toHaveBeenCalledTimes(2)
  expect(showError).toHaveBeenCalledOnce()
})

it('ignores subframe failures and superseded loads', async () => {
  const { load, showError, fail } = startRenderer()
  fail(-6, false)
  fail(-3)
  await new Promise<void>((resolve) => setImmediate(resolve))
  expect(load).toHaveBeenCalledOnce()
  expect(showError).not.toHaveBeenCalled()
})
