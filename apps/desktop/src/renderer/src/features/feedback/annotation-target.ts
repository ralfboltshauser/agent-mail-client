import type { FeedbackAnnotation } from '../../../../shared/feedback'

type Fiber = {
  type?: { name?: string; displayName?: string }
  return?: Fiber
}

function componentName(element: Element): string | null {
  const key = Object.keys(element).find((key) => key.startsWith('__reactFiber$'))
  const node = element as unknown as Record<string, Fiber>
  for (let fiber = key ? node[key] : undefined; fiber; fiber = fiber.return) {
    const name = fiber.type?.displayName ?? fiber.type?.name
    if (name && /^[\w.()-]{2,100}$/.test(name)) return name
  }
  return null
}

export function annotationTarget(element: Element): Omit<FeedbackAnnotation, 'note'> {
  // Build a structural selector from tags alone. IDs, attributes and text can
  // contain owner data in the mailbox or composer.
  const parts: string[] = []
  for (let node: Element | null = element; node; node = node.parentElement) {
    const tag = CSS.escape(node.localName)
    const peers = [...(node.parentElement?.children ?? [])].filter(
      (sibling) => sibling.localName === node?.localName,
    )
    parts.unshift(peers.length > 1 ? `${tag}:nth-of-type(${peers.indexOf(node) + 1})` : tag)
  }
  const { x, y, width, height } = element.getBoundingClientRect()
  return {
    selector: parts.join(' > '),
    component: componentName(element),
    bounds: {
      x: Math.round(x),
      y: Math.round(y),
      width: Math.round(width),
      height: Math.round(height),
    },
  }
}
