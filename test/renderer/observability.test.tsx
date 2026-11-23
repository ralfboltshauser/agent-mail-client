import { render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { ErrorBoundary } from '../../apps/desktop/src/renderer/src/components/error-boundary'
import { installRendererReporting } from '../../apps/desktop/src/renderer/src/lib/failure'

const secret = [
  'Synthetic Canary Subject',
  'Synthetic Canary Body',
  'Synthetic Canary Name',
  'canary@example.invalid',
  'synthetic-canary.pdf',
  'Synthetic Canary Reason',
  'canary-fixture-token',
  'https://canary.example.invalid/private',
].join(' ')

afterEach(() => vi.unstubAllGlobals())

it('forwards only metadata for React, window error, and rejected promises', () => {
  const reportFailure = vi.fn()
  vi.stubGlobal('amc', { reportFailure })
  installRendererReporting()
  const error = new TypeError(secret)
  error.stack = secret

  const windowError = new ErrorEvent('error', { error, message: secret, cancelable: true })
  expect(window.dispatchEvent(windowError)).toBe(false)
  const rejection = new Event('unhandledrejection', { cancelable: true })
  Object.defineProperty(rejection, 'reason', { value: error })
  expect(window.dispatchEvent(rejection)).toBe(false)

  function Broken(): never {
    throw error
  }
  const view = render(
    <ErrorBoundary onReload={vi.fn()}>
      <Broken />
    </ErrorBoundary>,
    { onCaughtError: () => {} },
  )
  try {
    expect(screen.getByRole('button', { name: 'Reload' })).toBeTruthy()
    expect(view.container.textContent).toMatch(/TypeError · Request [a-f0-9-]{36}/)
    expect(view.container.textContent).not.toContain('Canary')
    expect(reportFailure.mock.calls.map(([report]) => report.source)).toEqual([
      'window.error',
      'window.unhandledrejection',
      'react.boundary',
    ])
    for (const [report] of reportFailure.mock.calls) {
      expect(report).toEqual({
        source: report.source,
        errorClass: 'TypeError',
        requestId: expect.stringMatching(/^[a-f0-9-]{36}$/),
      })
    }
  } finally {
    view.unmount()
  }
})
