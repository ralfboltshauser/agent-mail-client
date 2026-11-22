import './dom'
import { act, render, screen, within } from '@testing-library/react'
import { StrictMode } from 'react'
import { expect, vi } from 'vitest'
import { App } from '@/app'
import { rendererAdapter } from './adapter'
import { commitCounts, commits } from './profile'

export const firstSubject = 'Field Notes · print proof'
export const threadCount = 8

export const listbox = () => screen.getByRole('listbox', { name: 'Threads' })
export const options = () => within(listbox()).getAllByRole('option')
export const reader = (subject = firstSubject) =>
  screen.getByRole('heading', { name: subject, level: 1 })
export const row = (subject: string) =>
  within(listbox()).getByRole('option', { name: (name) => name.includes(subject) })
export const selected = () => within(listbox()).getByRole('option', { selected: true })

export async function mount() {
  commits.clear()
  const adapter = rendererAdapter()
  vi.stubGlobal('amc', adapter.api)
  await act(async () => {
    render(
      <StrictMode>
        <App />
      </StrictMode>,
    )
  })
  const mountedRows = options()
  expect(mountedRows).toHaveLength(threadCount)
  expect(selected()).toBe(row(firstSubject))
  expect(reader().isConnected).toBe(true)
  // Fail visibly if a probe has stopped attaching to the real renderer.
  expect(Object.keys(commitCounts().rows).sort()).toEqual(
    mountedRows.map((option) => option.getAttribute('data-thread-id')).sort(),
  )
  for (const region of ['App', 'MailWorkspace', 'AppSidebar', 'ThreadList', 'ThreadView']) {
    expect(commits.get(region)).toBeGreaterThan(0)
  }
  commits.clear()
  return adapter
}
