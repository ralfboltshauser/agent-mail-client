import { act, fireEvent, screen } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import { rendererAdapter } from './adapter'
import { commits, expectBudget } from './profile'
import { mount, reader, row } from './workspace'

const storageKey = 'amc.remote-images.v1'
const banner = 'Remote images are blocked.'
const remoteCsp = 'img-src data: cid: https: http:;'
const localCsp = 'img-src data: cid:;'
const html = `
  <picture><source srcset="https://mail.example/picture.png"><img width="480" height="320"></picture>
  <a href="https://mail.example/link" target="_self">Read more</a>
  <script>window.test = true</script>
  <form action="https://mail.example/form"><input name="message"></form>
  <img src="https://mail.example/pixel.png" onerror="window.test = true">
`

function remoteMail() {
  const adapter = rendererAdapter()
  const original = adapter.api.thread.getMockImplementation()
  adapter.api.thread.mockImplementation(async (id) => {
    const result = await original?.(id)
    if (!result) return null
    return {
      ...result,
      messages: result.messages.map((message) =>
        message.id.endsWith(':latest')
          ? {
              ...message,
              hasHtml: true,
              accountId: id === 'thread-3' ? 'other-account' : message.accountId,
              from: {
                name: 'Synthetic Sender',
                address: id === 'thread-1' ? 'Sender@Example.com' : 'sender@example.com',
              },
            }
          : message,
      ),
    }
  })
  const messageHtml = vi.fn(async () => html)
  adapter.api.messageHtml = messageHtml
  return { adapter, messageHtml }
}

function messageFrame() {
  const frame = document.querySelector('iframe[title="Message"]')
  if (!(frame instanceof HTMLIFrameElement)) throw new Error('Expected message iframe')
  return frame
}

function expectBlocked() {
  expect(screen.getByText(banner)).toBeTruthy()
  expect(messageFrame().srcdoc).toContain(localCsp)
}

function expectAllowed() {
  expect(screen.queryByText(banner)).toBeNull()
  const frame = messageFrame()
  expect(frame.srcdoc).toContain(remoteCsp)
  expect(frame.srcdoc).toContain('https://mail.example/pixel.png')
  expect(frame.srcdoc).toContain('<a href="https://mail.example/link" target="_blank">')
  expect(frame.srcdoc).toContain("form-action 'none'")
  expect(frame.srcdoc).not.toMatch(/<script|<form|<input|onerror=/)
  expect(frame.getAttribute('sandbox')).toBe('allow-same-origin')
}

async function openSettings() {
  await act(async () => fireEvent.click(screen.getByRole('button', { name: /Command palette/ })))
  await act(async () => fireEvent.click(screen.getByText('Settings')))
  return screen.getByRole<HTMLInputElement>('checkbox', {
    name: 'Load remote images automatically',
  })
}

it('loads remote images on first open when automatic loading was saved', async () => {
  localStorage.setItem(storageKey, JSON.stringify({ automatic: true, senders: [] }))
  await mount(remoteMail().adapter)
  expectAllowed()
})

it('updates the open reader from Settings and persists the banner global action', async () => {
  const { adapter, messageHtml } = remoteMail()
  await mount(adapter)
  expectBlocked()
  const frame = messageFrame()
  const heading = reader()
  const checkbox = await openSettings()
  expect(checkbox.checked).toBe(false)
  commits.clear()

  await act(async () => fireEvent.click(checkbox))
  expect(checkbox.checked).toBe(true)
  expectAllowed()
  expect(messageFrame()).toBe(frame)
  await act(async () => fireEvent.click(checkbox))
  expect(checkbox.checked).toBe(false)
  // The settings modal hides the reader from the accessibility tree until it closes.
  expect(messageFrame().srcdoc).toContain(localCsp)
  expect(messageFrame()).toBe(frame)
  expectBudget({ app: 0, workspace: 0, reader: 0, rows: 0 })

  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Close' })))
  expectBlocked()
  expect(reader()).toBe(heading)
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Always load' })))
  expectAllowed()
  expect(messageFrame()).toBe(frame)
  expect(messageHtml).toHaveBeenCalledTimes(1)
  expect((await openSettings()).checked).toBe(true)
  expect(localStorage.getItem(storageKey)).toBe(JSON.stringify({ automatic: true, senders: [] }))
})

it('remembers a sender across messages only within the same account', async () => {
  await mount(remoteMail().adapter)
  expectBlocked()
  const frame = messageFrame()
  await act(async () =>
    fireEvent.click(screen.getByRole('button', { name: 'Always from this sender' })),
  )
  expectAllowed()
  expect(messageFrame()).toBe(frame)
  expect(localStorage.getItem(storageKey)).toBe(
    JSON.stringify({
      automatic: false,
      senders: [JSON.stringify(['studio', 'sender@example.com'])],
    }),
  )

  await act(async () => fireEvent.click(row('Sunday at the studio')))
  expectAllowed()
  const third = document.querySelector('[data-thread-id="thread-3"]')
  if (!third) throw new Error('Expected a third thread')
  await act(async () => fireEvent.click(third))
  expectBlocked()
})
