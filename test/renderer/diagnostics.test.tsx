import { act, fireEvent, screen, within } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import { deferred, rendererAdapter } from './adapter'
import { mount } from './workspace'

it('copies through main from the command palette and acknowledges completion', async () => {
  const adapter = rendererAdapter()
  const request = deferred<void>()
  adapter.api.copyDiagnostics.mockReturnValueOnce(request.promise)
  await mount(adapter)
  vi.useRealTimers()

  fireEvent.keyDown(document.body, { key: 'k', metaKey: true })
  fireEvent.click(within(screen.getByRole('dialog')).getByText('Copy Diagnostics'))
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(adapter.api.copyDiagnostics).toHaveBeenCalledExactlyOnceWith()
  expect(screen.queryByText('Diagnostics copied')).toBeNull()

  await act(async () => request.resolve())
  expect(await screen.findByText('Diagnostics copied')).toBeTruthy()
})

it('shows the failure from a Help menu request', async () => {
  const adapter = rendererAdapter()
  adapter.api.copyDiagnostics.mockRejectedValueOnce(new Error('Synthetic copy failure'))
  await mount(adapter)
  vi.useRealTimers()

  await act(async () => adapter.emitCopyDiagnostics())
  expect(adapter.api.copyDiagnostics).toHaveBeenCalledExactlyOnceWith()
  expect(await screen.findByText('Could not copy diagnostics')).toBeTruthy()
  expect(screen.queryByText('Diagnostics copied')).toBeNull()
})
