// @vitest-environment jsdom

import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { expect, it, vi } from 'vitest'

it('offers reload in the renderer HTML when the application bundle never mounts', () => {
  const html = readFileSync('apps/desktop/src/renderer/index.html', 'utf8')
  const page = new DOMParser().parseFromString(html, 'text/html')
  const root = page.querySelector('#root')
  const button = root?.querySelector('button')
  const script = page.querySelector('script:not([src])')?.textContent ?? ''
  const digest = createHash('sha256').update(script).digest('base64')
  const reload = vi.fn()

  expect(root?.textContent).toContain('AMC is starting…')
  expect(button?.textContent).toBe('Reload')
  expect(
    page.querySelector('meta[http-equiv="Content-Security-Policy"]')?.getAttribute('content'),
  ).toContain(`'sha256-${digest}'`)
  new Function('document', 'location', script)(page, { reload })
  button?.click()
  expect(reload).toHaveBeenCalledOnce()
})
