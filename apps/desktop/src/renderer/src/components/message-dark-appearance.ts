type RGB = [number, number, number]
type Color = { rgb: RGB; alpha: number }
type Paint = { background: RGB | null; originalInk: string; ink: string }

const CANVAS: RGB = [29, 29, 29]
const LIGHT_INK: RGB = [226, 226, 226]
const BORDER_SIDES = ['top', 'right', 'bottom', 'left'] as const

function readColor(value: string): Color | null {
  const match = /^rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?\)$/.exec(value)
  if (!match) return null
  const [, r, g, b, alpha = '1'] = match
  return { rgb: [Number(r), Number(g), Number(b)], alpha: Number(alpha) }
}

const cssColor = ([r, g, b]: RGB, alpha = 1) =>
  alpha === 1 ? `rgb(${r}, ${g}, ${b})` : `rgba(${r}, ${g}, ${b}, ${alpha})`

export const MESSAGE_DARK_CANVAS = cssColor(CANVAS)

const channels = ([r, g, b]: RGB, map: (channel: number, index: number) => number): RGB => [
  map(r, 0),
  map(g, 1),
  map(b, 2),
]

function brightness(rgb: RGB) {
  const [r, g, b] = channels(rgb, (channel) => {
    const value = channel / 255
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
  })
  return r * 0.2126 + g * 0.7152 + b * 0.0722
}

function contrast(a: RGB, b: RGB) {
  const x = brightness(a)
  const y = brightness(b)
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05)
}

const neutral = (rgb: RGB) => Math.max(...rgb) - Math.min(...rgb) < 22

function darkSurface(rgb: RGB) {
  if (brightness(rgb) <= 0.18) return rgb
  const scale = neutral(rgb) ? 0.13 : 0.39
  return channels(rgb, (value) => Math.round(value * scale))
}

function composite({ rgb, alpha }: Color, behind: RGB | null) {
  if (alpha === 1) return rgb
  if (!behind) return null
  return channels(rgb, (value, index) => value * alpha + behind[index] * (1 - alpha))
}

function readableInk(color: Color | null, background: RGB | null) {
  if (!color || color.alpha !== 1 || !background || contrast(color.rgb, background) >= 4.5)
    return null
  if (!neutral(color.rgb)) {
    const tint = channels(color.rgb, (value) => Math.round(value * 0.45 + 140))
    if (contrast(tint, background) >= 4.5) return tint
  }
  if (contrast(LIGHT_INK, background) >= 4.5) return LIGHT_INK
  const white: RGB = [255, 255, 255]
  const black: RGB = [0, 0, 0]
  return contrast(white, background) >= contrast(black, background) ? white : black
}

/** Recolor solid HTML surfaces in the loaded frame. Restore only properties we changed. */
export function applyMessageDarkAppearance(doc: Document) {
  const view = doc.defaultView
  if (!view) return
  const root = doc.documentElement
  const paint = new Map<Element, Paint>()
  const updates: Array<{ element: HTMLElement; changes: Map<string, string> }> = []

  for (const element of [root, doc.body, ...doc.body.querySelectorAll<HTMLElement>('*')]) {
    if (element.namespaceURI !== 'http://www.w3.org/1999/xhtml') continue
    const css = view.getComputedStyle(element)
    const parent = element.parentElement ? paint.get(element.parentElement) : undefined
    const changes = new Map<string, string>()
    let background = parent?.background ?? null

    if (css.backgroundImage !== 'none') {
      // Text may be over any part of an image or gradient. Keep the sender's colors there.
      background = null
    } else if (element === root) {
      background = CANVAS
      changes.set('background-color', MESSAGE_DARK_CANVAS)
    } else {
      const surface = readColor(css.backgroundColor)
      if (!surface) background = null
      else if (surface.alpha > 0) {
        const rgb = darkSurface(surface.rgb)
        background = composite({ rgb, alpha: surface.alpha }, background)
        if (rgb !== surface.rgb) changes.set('background-color', cssColor(rgb, surface.alpha))
      }
    }

    const color = readableInk(readColor(css.color), background)
    const ink = color ? cssColor(color) : css.color
    const inheritsChangedInk =
      parent && parent.ink !== parent.originalInk && css.color === parent.originalInk
    if (ink !== css.color || inheritsChangedInk) changes.set('color', ink)
    paint.set(element, { background, originalInk: css.color, ink })

    if (background && brightness(background) < 0.18) {
      for (const side of BORDER_SIDES) {
        if (css.getPropertyValue(`border-${side}-width`) === '0px') continue
        const property = `border-${side}-color`
        const border = readColor(css.getPropertyValue(property))
        if (border?.alpha === 1 && neutral(border.rgb) && brightness(border.rgb) > 0.74)
          changes.set(property, '#4b4b4b')
      }
    }
    if (changes.size) updates.push({ element, changes })
  }

  // Read the original cascade before writing styles so one element cannot skew the next sample.
  const restore = updates.map(({ element, changes }) => {
    const { style } = element
    const hadStyle = element.hasAttribute('style')
    const previous = Array.from(changes.keys(), (name) => ({
      name,
      value: style.getPropertyValue(name),
      priority: style.getPropertyPriority(name),
    }))
    for (const [name, value] of changes) style.setProperty(name, value, 'important')
    return () => {
      for (const { name, value, priority } of previous) style.setProperty(name, value, priority)
      if (!hadStyle && style.length === 0) element.removeAttribute('style')
    }
  })
  return () => {
    for (const undo of restore) undo()
  }
}
