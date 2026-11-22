import { cleanup } from '@testing-library/react'
import { afterEach, beforeEach, vi } from 'vitest'

// ProseMirror asks for text-range geometry when scrolling its selection.
Object.defineProperties(Range.prototype, {
  getClientRects: { configurable: true, value: () => [] },
  getBoundingClientRect: { configurable: true, value: () => new DOMRect() },
})

// JSDOM exposes the element without the modal top-layer methods.
HTMLDialogElement.prototype.showModal ??= function () {
  this.open = true
}
HTMLDialogElement.prototype.close ??= function () {
  this.open = false
}

// cmdk scrolls the selected command into view.
Element.prototype.scrollIntoView = () => {}

beforeEach(() => {
  vi.useFakeTimers()
  const storage = new Map<string, string>()
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
    removeItem: (key: string) => storage.delete(key),
  })
  vi.stubGlobal('scrollTo', () => {})
  vi.stubGlobal('matchMedia', () => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  }))
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  )

  // TanStack Virtual reads the scroll element's layout, which jsdom does not calculate.
  const height = Object.getOwnPropertyDescriptor(Element.prototype, 'clientHeight')?.get
  const width = Object.getOwnPropertyDescriptor(Element.prototype, 'clientWidth')?.get
  vi.spyOn(Element.prototype, 'clientHeight', 'get').mockImplementation(function (
    this: HTMLElement,
  ) {
    return this.hasAttribute('data-thread-viewport') ? 720 : (height?.call(this) ?? 0)
  })
  vi.spyOn(Element.prototype, 'clientWidth', 'get').mockImplementation(function (
    this: HTMLElement,
  ) {
    return this.hasAttribute('data-thread-viewport') ? 380 : (width?.call(this) ?? 0)
  })
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})
