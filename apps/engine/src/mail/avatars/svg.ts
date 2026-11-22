import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { initWasm, Resvg } from '@resvg/resvg-wasm'
import { SaxesParser } from 'saxes'

declare const AMC_AVATAR_WASM: string

const shared =
  'id fill fill-opacity fill-rule opacity stroke stroke-width stroke-opacity stroke-linecap stroke-linejoin stroke-miterlimit transform clip-path clip-rule'
const fields = new Map(
  Object.entries({
    svg: 'xmlns width height viewBox preserveAspectRatio version baseProfile',
    title: '',
    desc: '',
    defs: '',
    g: shared,
    path: `${shared} d`,
    rect: `${shared} x y width height rx ry`,
    circle: `${shared} cx cy r`,
    ellipse: `${shared} cx cy rx ry`,
    line: `${shared} x1 y1 x2 y2`,
    polygon: `${shared} points`,
    polyline: `${shared} points`,
    linearGradient: 'id x1 y1 x2 y2 gradientUnits gradientTransform spreadMethod',
    radialGradient: 'id cx cy r fx fy gradientUnits gradientTransform spreadMethod',
    stop: 'offset stop-color stop-opacity',
    clipPath: 'id clipPathUnits transform',
  }).map(([element, attributes]) => [element, new Set(attributes.split(' '))]),
)

const reject = () => {
  throw new Error('Invalid static SVG')
}
const name = '[a-zA-Z_][a-zA-Z0-9_.-]{0,63}'
const localReference = new RegExp(`^url\\(#${name}\\)$`)
const id = new RegExp(`^${name}$`)
const number = /^[+\-\d.][+\-\d.eE%\s,]*$/
const color = /^(?:#[a-f\d]{3,8}|[a-zA-Z]{1,24}|rgba?\([\d.,%\s]+\))$/i
const transform = /^(?:(?:matrix|translate|scale|rotate|skewX|skewY)\([\d.\-+eE,\s]+\)[,\s]*)+$/

function allowedValue(attribute: string, value: string): boolean {
  switch (attribute) {
    case 'xmlns':
      return value === 'http://www.w3.org/2000/svg'
    case 'fill':
    case 'stroke':
      return color.test(value) || localReference.test(value)
    case 'stop-color':
      return color.test(value)
    case 'clip-path':
      return localReference.test(value)
    case 'id':
      return id.test(value)
    case 'd':
      return /^[MmZzLlHhVvCcSsQqTtAa.eE0-9,\s+-]+$/.test(value)
    case 'transform':
    case 'gradientTransform':
      return transform.test(value)
    case 'preserveAspectRatio':
      return /^(?:none|x(?:Min|Mid|Max)Y(?:Min|Mid|Max)(?: (?:meet|slice))?)$/.test(value)
    case 'version':
      return value === '1.1' || value === '1.2'
    case 'baseProfile':
      return value === 'tiny' || value === 'tiny-ps'
    case 'fill-rule':
    case 'clip-rule':
      return value === 'nonzero' || value === 'evenodd'
    case 'stroke-linecap':
      return /^(?:butt|round|square)$/.test(value)
    case 'stroke-linejoin':
      return /^(?:miter|round|bevel)$/.test(value)
    case 'gradientUnits':
    case 'clipPathUnits':
      return /^(?:userSpaceOnUse|objectBoundingBox)$/.test(value)
    case 'spreadMethod':
      return /^(?:pad|reflect|repeat)$/.test(value)
    default:
      return number.test(value)
  }
}

export function validateSvg(bytes: Buffer): string {
  const input = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  if (input.includes('&')) reject()
  const parser = new SaxesParser()
  let root = false
  let nodes = 0
  const stack: string[] = []
  parser.on('error', reject)
  parser.on('doctype', reject)
  parser.on('processinginstruction', reject)
  parser.on('cdata', reject)
  parser.on('opentag', ({ name: element, attributes }) => {
    const allowed = fields.get(element)
    if (!allowed || ++nodes > 1024 || stack.length >= 24) return reject()
    if (!root) {
      if (element !== 'svg' || attributes.xmlns !== 'http://www.w3.org/2000/svg') reject()
      root = true
    } else if (element === 'svg' || stack.at(-1) === 'title' || stack.at(-1) === 'desc') reject()
    for (const [attribute, value] of Object.entries(attributes)) {
      const limit = attribute === 'd' || attribute === 'points' ? 32_768 : 512
      if (attribute === 'clip-path' && stack.includes('clipPath')) reject()
      if (!allowed.has(attribute) || value.length > limit || !allowedValue(attribute, value))
        reject()
    }
    stack.push(element)
  })
  parser.on('closetag', () => {
    stack.pop()
  })
  parser.on('text', (text) => {
    if (text.trim() && stack.at(-1) !== 'title' && stack.at(-1) !== 'desc') reject()
  })
  parser.write(input).close()
  if (!root) reject()
  return input
}

let initialized: Promise<void> | undefined

async function initializeWasm(): Promise<void> {
  const wasm =
    typeof AMC_AVATAR_WASM === 'string'
      ? Buffer.from(AMC_AVATAR_WASM, 'base64')
      : await readFile(createRequire(import.meta.url).resolve('@resvg/resvg-wasm/index_bg.wasm'))
  await initWasm(Uint8Array.from(wasm))
}

export async function rasterSvg(
  bytes: Buffer,
  dimensions: (width: number, height: number) => void,
) {
  const svg = validateSvg(bytes)
  initialized ??= initializeWasm()
  await initialized
  // The WASM decoder has no filesystem or network access. It gets no fonts or image resources.
  const renderer = new Resvg(svg, { font: { fontBuffers: [] } })
  try {
    dimensions(renderer.width, renderer.height)
    const rendered = renderer.render()
    try {
      return Buffer.from(rendered.asPng())
    } finally {
      rendered.free()
    }
  } finally {
    renderer.free()
  }
}
