import { act, fireEvent, screen, within } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import { activityRunId, createActivityFixture, removedThreadId } from '@/dev/agent-activity-fixture'
import type { AmcApi } from '../../apps/desktop/src/shared/api'
import { deferred, rendererAdapter } from './adapter'
import { commits, expectBudget } from './profile'
import { firstSubject, mount } from './workspace'

function setupActivity() {
  const adapter = rendererAdapter()
  const fixture = createActivityFixture(Date.now())
  const read = vi.fn(fixture.agentActivity)
  const undo = vi.fn(fixture.undoAgentAction)
  adapter.api.agentActivity = read
  adapter.api.undoAgentAction = undo
  return { adapter, fixture, read, undo }
}

const dialog = () => within(screen.getByRole('dialog', { name: 'Agent activity' }))
const feed = () => dialog().getByRole('region', { name: 'Activity feed' })
const button = (name: string) => dialog().getByRole('button', { name })
const click = async (control: HTMLElement) => {
  await act(async () => control.click())
}

function event(operation: string, status: string) {
  const row = dialog()
    .getAllByRole('heading', { name: operation, level: 4 })
    .map((heading) => heading.closest('li'))
    .find((item) => item && within(item).queryByText(status, { exact: true }))
  if (!row) throw new Error(`No ${operation} event with status ${status}`)
  return within(row)
}

async function openActivity() {
  const trigger = screen.getByRole('button', { name: 'Agent activity' })
  act(() => trigger.focus())
  await click(trigger)
  return trigger
}

it('shows dated operations, current Thread identities and outcomes before diagnostics', async () => {
  const { adapter, read } = setupActivity()
  await mount(adapter)
  adapter.api.thread.mockClear()
  adapter.api.summaries.mockClear()
  const trigger = await openActivity()
  act(() => vi.advanceTimersByTime(0))
  expect(read).toHaveBeenCalledExactlyOnceWith(undefined)
  expect(adapter.api.summaries).toHaveBeenCalledTimes(1)
  expect(adapter.api.thread).not.toHaveBeenCalled()
  expect(dialog().getAllByRole('heading', { level: 3 })).toHaveLength(2)
  expect(document.activeElement).toBe(button('Refresh'))

  const assigned = event('Assign Bucket', 'Applied')
  expect(assigned.getByText(firstSubject)).toBeTruthy()
  expect(assigned.getByText('Automated triage · Mina Park')).toBeTruthy()
  expect(feed().textContent).not.toContain(activityRunId)
  expect(feed().textContent).not.toContain(removedThreadId)
  expect(feed().textContent).not.toContain('Could you approve')
  expect(assigned.queryByRole('button', { name: 'Undo' })).toBeNull()
  expect(event('Mark as read', 'Pending').queryByRole('button', { name: 'Undo' })).toBeNull()
  expect(event('Add Label', 'Failed').queryByRole('button', { name: 'Undo' })).toBeNull()
  expect(event('Assign Bucket', 'Rejected').getByText('Thread unavailable')).toBeTruthy()
  expect(event('Update draft', 'Applied').getByText(/Draft saved in AMC/)).toBeTruthy()
  expect(event('Star', 'Applied').getByText(/Newer Gmail changes preserved/)).toBeTruthy()

  const details = assigned.getByRole('button', { name: 'Details' })
  await click(details)
  expect(details.getAttribute('aria-expanded')).toBe('true')
  expect(assigned.getByText(`triage-${activityRunId}`)).toBeTruthy()
  expect(assigned.getByText(activityRunId)).toBeTruthy()
  expect(assigned.getByText(/Thread ID thread-1/)).toBeTruthy()
  expect(assigned.getByText(/T\d\d:42:00\.000Z$/)).toBeTruthy()
  expect(assigned.getByText('activity-bucket')).toBeTruthy()

  const archive = event('Archive', 'Partially applied')
  expect(archive.getByText('3 Threads')).toBeTruthy()
  await click(archive.getByRole('button', { name: 'Details' }))
  expect(archive.getByText('Sunday at the studio')).toBeTruthy()
  expect(archive.getByText('Thread unavailable')).toBeTruthy()
  expect(archive.getByText(/Thread is no longer available/)).toBeTruthy()
  expect(archive.getByText(`Thread ID ${removedThreadId}`)).toBeTruthy()

  await click(button('Close'))
  act(() => vi.advanceTimersByTime(0))
  expect(document.activeElement).toBe(trigger)
})

it('preserves rows, focus and scroll on same-page refresh and replaces them on accepted pagination', async () => {
  const { adapter, read } = setupActivity()
  await mount(adapter)
  await openActivity()
  const details = event('Assign Bucket', 'Applied').getByRole('button', { name: 'Details' })
  act(() => details.focus())
  await click(details)
  const viewport = feed()
  viewport.scrollTop = 96
  commits.clear()
  await click(button('Refresh'))
  expect(feed()).toBe(viewport)
  expect(event('Assign Bucket', 'Applied').getByRole('button', { name: 'Details' })).toBe(details)
  expect(details.getAttribute('aria-expanded')).toBe('true')
  expect(document.activeElement).toBe(details)
  expect(viewport.scrollTop).toBe(96)
  expectBudget({ workspace: 0, list: 0, reader: 0, rows: 0 })

  const older = button('Older')
  act(() => older.focus())
  read.mockRejectedValueOnce(new Error('Synthetic read failure'))
  await click(older)
  expect(dialog().getByRole('alert').textContent).toMatch(/Could not load/)
  expect(details.isConnected).toBe(true)
  expect(document.activeElement).toBe(older)
  expect(viewport.scrollTop).toBe(96)

  await click(older)
  expect(event('Create draft', 'Applied').getByText('Standalone draft')).toBeTruthy()
  expect(details.isConnected).toBe(false)
  expect(button('Older')).toBe(older)
  expect(older.getAttribute('aria-disabled')).toBe('true')
  expect(viewport.scrollTop).toBe(0)
  expect(document.activeElement).toBe(older)
  expect(read).toHaveBeenLastCalledWith(8)
  await click(button('Newest'))
  expect(read).toHaveBeenLastCalledWith(undefined)
  expect(feed().textContent).toContain(firstSubject)

  read.mockResolvedValueOnce({ actions: [], nextBefore: null })
  await click(button('Refresh'))
  expect(dialog().getByText('No Agent activity yet')).toBeTruthy()
  expect(dialog().queryByText(firstSubject)).toBeNull()
})

it('batches distinct targets and rejects stale summary results after refresh', async () => {
  const { adapter, read } = setupActivity()
  const original = await read(undefined)
  const ids = Array.from({ length: 105 }, (_, i) => `missing-fixture-thread-${i}`)
  const bulk = Array.from({ length: 6 }, (_, i) => ({
    ...original.actions[0],
    id: `fixture-batch-${i}`,
    threads: ids.slice(i * 20, (i + 1) * 20),
  }))
  read.mockResolvedValueOnce({ ...original, actions: [...original.actions, ...bulk] })
  const initialSummary = deferred<Awaited<ReturnType<AmcApi['summaries']>>>()
  const rows = await adapter.api.summaries(['thread-1'])
  await mount(adapter)
  adapter.api.summaries.mockClear()
  adapter.api.thread.mockClear()
  adapter.api.summaries
    .mockReturnValueOnce(initialSummary.promise)
    .mockRejectedValueOnce(new Error('Synthetic summary failure'))
  await openActivity()
  expect(feed().textContent).toContain('Automated triage')
  expect(event('Assign Bucket', 'Rejected').getByText('Thread unavailable')).toBeTruthy()
  const calls = adapter.api.summaries.mock.calls
  expect(calls.map(([batch]) => batch.length)).toEqual([100, 13])
  expect(new Set(calls.flatMap(([batch]) => batch)).size).toBe(113)

  await click(button('Refresh'))
  expect(feed().textContent).toContain(firstSubject)
  await act(async () =>
    initialSummary.resolve(rows.map((row) => ({ ...row, subject: 'Stale subject' }))),
  )
  expect(feed().textContent).toContain(firstSubject)
  expect(feed().textContent).not.toContain('Stale subject')

  adapter.api.summaries.mockRejectedValueOnce(new Error('Replica temporarily unavailable'))
  await click(button('Refresh'))
  expect(event('Archive', 'Partially applied').getByText('3 Threads')).toBeTruthy()
  expect(feed().textContent).not.toContain(firstSubject)
  expect(dialog().queryByRole('alert')).toBeNull()
  expect(adapter.api.thread).not.toHaveBeenCalled()
})

it('suppresses closed-session reads and distinguishes Undo failure from a failed follow-up refresh', async () => {
  const { adapter, fixture, read, undo } = setupActivity()
  const late = deferred<Awaited<ReturnType<AmcApi['agentActivity']>>>()
  read.mockReturnValueOnce(late.promise)
  await mount(adapter)
  await openActivity()
  await click(button('Close'))
  act(() => vi.advanceTimersByTime(0))
  await openActivity()
  await act(async () => late.resolve({ actions: [], nextBefore: null }))
  expect(feed().textContent).toContain(firstSubject)

  const control = button('Undo')
  act(() => control.focus())
  undo.mockRejectedValueOnce(new Error('Synthetic Undo failed'))
  await click(control)
  expect(dialog().getByRole('alert').textContent).toMatch(/Could not undo/)
  expect(control.getAttribute('aria-disabled')).toBe('false')

  const write = deferred<void>()
  undo.mockImplementationOnce(async (id) => {
    await write.promise
    await fixture.undoAgentAction(id)
    read.mockRejectedValueOnce(new Error('Refresh failed after Undo'))
  })
  await act(async () => {
    fireEvent.click(control)
    fireEvent.click(control)
  })
  expect(undo).toHaveBeenCalledTimes(2)
  expect(control.getAttribute('aria-disabled')).toBe('true')
  await act(async () => write.resolve())
  expect(dialog().getByRole('alert').textContent).toMatch(/Undo was requested/)
  await click(control)
  expect(undo).toHaveBeenCalledTimes(2)
  await click(button('Refresh'))
  expect(dialog().queryByRole('button', { name: 'Undo' })).toBeNull()
  expect(event('Archive', 'Partially applied').getByText('Undone')).toBeTruthy()
  expect(document.activeElement).toBe(button('Refresh'))
})

it('waits for an in-flight Undo before reading a reopened dialog', async () => {
  const { adapter, fixture, read, undo } = setupActivity()
  const write = deferred<void>()
  undo.mockImplementationOnce(async (id) => {
    await write.promise
    await fixture.undoAgentAction(id)
  })
  await mount(adapter)
  await openActivity()
  await click(button('Undo'))
  await click(button('Close'))
  act(() => vi.advanceTimersByTime(0))
  await openActivity()
  expect(read).toHaveBeenCalledTimes(1)
  expect(dialog().getByText('Loading activity…')).toBeTruthy()

  await act(async () => write.resolve())
  expect(read).toHaveBeenCalledTimes(2)
  expect(undo).toHaveBeenCalledExactlyOnceWith('activity-archive')
  expect(event('Archive', 'Partially applied').getByText('Undone')).toBeTruthy()
  expect(dialog().queryByRole('button', { name: 'Undo' })).toBeNull()
})
