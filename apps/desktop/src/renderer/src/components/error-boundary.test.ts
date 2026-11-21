// @vitest-environment jsdom

import { act, createElement, StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { App } from '../app'
import { ErrorBoundary } from './error-boundary'

it('offers Reload if the initial desktop status request fails', async () => {
  const container = document.createElement('div')
  const root = createRoot(container, { onCaughtError: () => {} })
  const reload = vi.fn()
  const unsubscribe = vi.fn()
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('matchMedia', () => ({
    matches: false,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }))
  vi.stubGlobal('amc', {
    status: vi.fn().mockRejectedValue(new Error('Status unavailable')),
    onStatus: () => unsubscribe,
  })
  try {
    await act(async () =>
      root.render(
        createElement(
          StrictMode,
          null,
          createElement(ErrorBoundary, { onReload: reload }, createElement(App)),
        ),
      ),
    )
    expect(container.querySelector('[role="alert"]')?.textContent).toBe('AMC couldn’t start.')
    const button = container.querySelector('button')
    expect(button?.textContent).toBe('Reload')
    button?.click()
    expect(reload).toHaveBeenCalledOnce()
  } finally {
    await act(async () => root.unmount())
    vi.unstubAllGlobals()
  }
})
