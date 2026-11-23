import { render, screen } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import { ErrorBoundary } from '../../apps/desktop/src/renderer/src/components/error-boundary'
import {
  loadReview,
  saveReview,
} from '../../apps/desktop/src/renderer/src/features/triage-review/journal'
import { installRendererReporting } from '../../apps/desktop/src/renderer/src/lib/failure'

import './dom'

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

it('keeps private error text from older triage history out of restored action details', () => {
  const key = 'amc-triage-review-v1'
  const scope = 'synthetic-pairing'
  const detail = 'EngineError · Request 17927277-3fff-49c2-af62-7595000dd7d4'
  localStorage.setItem(
    key,
    JSON.stringify({
      scope,
      sessions: {},
      history: [
        {
          error: secret,
          decision: { kind: 'organise' },
          undo: { error: secret },
        },
      ],
    }),
  )

  try {
    const restored = loadReview(scope)
    expect(restored.history[0]).toMatchObject({
      error: 'The previous action reported a failure.',
      undo: { error: 'The previous Undo reported a failure.' },
    })
    const action = restored.history[0]
    if (!action) throw new Error('Missing fixture action')
    action.error = detail
    saveReview(restored)
    expect(loadReview(scope).history[0]?.error).toBe(detail)
    expect(localStorage.getItem(key)).not.toContain(secret)
  } finally {
    localStorage.removeItem(key)
  }
})
