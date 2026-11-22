import { inflateSync } from 'node:zlib'
import { decode } from 'jpeg-js'
import { PNG } from 'pngjs'
import { MAX_INPUT, MAX_PNG } from './limits.ts'
import { rasterSvg } from './svg.ts'

const SIZE = 64
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])

interface Pixels {
  width: number
  height: number
  data: Uint8Array
}

function dimensions(width: number, height: number): void {
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width <= 0 ||
    height <= 0 ||
    width > 1024 ||
    height > 1024
  )
    throw new Error('Invalid image dimensions')
}

function readPng(bytes: Buffer): Pixels {
  if (!bytes.subarray(0, 8).equals(PNG_SIGNATURE) || bytes.toString('ascii', 12, 16) !== 'IHDR')
    throw new Error('Invalid PNG')
  const width = bytes.readUInt32BE(16)
  const height = bytes.readUInt32BE(20)
  dimensions(width, height)
  // Validate the header and IDAT stream before pngjs allocates its pixel buffers.
  const idat: Buffer[] = []
  let ended = false
  for (let offset = 8; offset + 12 <= bytes.length; ) {
    const length = bytes.readUInt32BE(offset)
    const type = bytes.toString('ascii', offset + 4, offset + 8)
    const end = offset + length + 12
    if (end > bytes.length) throw new Error('Invalid PNG chunk')
    if (type === 'IHDR' && (offset !== 8 || length !== 13)) throw new Error('Invalid PNG header')
    if (type === 'IDAT') idat.push(bytes.subarray(offset + 8, end - 4))
    if (['acTL', 'fcTL', 'fdAT'].includes(type)) throw new Error('Animated PNG')
    if (type === 'IEND') {
      ended = length === 0 && end === bytes.length
      break
    }
    offset = end
  }
  if (!ended) throw new Error('Invalid PNG end')
  inflateSync(Buffer.concat(idat), { maxOutputLength: 8 * width * height + height * 2 })
  return PNG.sync.read(bytes)
}

function readIcon(bytes: Buffer): Pixels {
  if (bytes.readUInt32LE(0) !== 0x0001_0000) throw new Error('Invalid ICO')
  const count = bytes.readUInt16LE(4)
  const directoryEnd = 6 + count * 16
  if (!count || count > 64 || directoryEnd > bytes.length) throw new Error('Invalid ICO directory')
  const entries = Array.from({ length: count }, (_, i) => {
    const entry = 6 + i * 16
    return {
      width: bytes[entry] || 256,
      height: bytes[entry + 1] || 256,
      depth: bytes.readUInt16LE(entry + 6),
      length: bytes.readUInt32LE(entry + 8),
      offset: bytes.readUInt32LE(entry + 12),
    }
  })
  entries.sort((a, b) => Math.abs(a.width - SIZE) - Math.abs(b.width - SIZE) || b.depth - a.depth)
  for (const { width, height, offset, length } of entries) {
    if (offset < directoryEnd || !length || offset + length > bytes.length)
      throw new Error('Invalid ICO entry')
    const image = bytes.subarray(offset, offset + length)
    if (image.subarray(0, 8).equals(PNG_SIGNATURE)) return readPng(image)
    const dib = readIconBitmap(image, width, height)
    if (dib) return dib
  }
  throw new Error('Unsupported ICO')
}

function readIconBitmap(image: Buffer, width: number, height: number): Pixels | null {
  if (
    image.length < 40 ||
    image.readUInt32LE(0) !== 40 ||
    image.readInt32LE(4) !== width ||
    image.readInt32LE(8) !== height * 2 ||
    image.readUInt16LE(12) !== 1 ||
    image.readUInt32LE(16) !== 0
  )
    return null
  const depth = image.readUInt16LE(14)
  if (![1, 4, 8, 24, 32].includes(depth)) return null
  const indexed = depth <= 8
  const entries = indexed ? image.readUInt32LE(32) || 2 ** depth : 0
  if (entries > 2 ** depth) throw new Error('Invalid ICO palette')
  const pixels = 40 + 4 * entries
  const stride = Math.ceil((width * depth) / 32) * 4
  const maskStride = Math.ceil(width / 32) * 4
  const mask = pixels + stride * height
  if (
    image.length < mask ||
    (image.length < mask + maskStride * height && !(depth === 32 && image.length === mask))
  )
    throw new Error('Truncated ICO')
  const data = new Uint8Array(width * height * 4)
  let hasAlpha = false
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const row = height - y - 1
      const offset = pixels + row * stride
      const source = indexed
        ? paletteOffset(image, offset, x, depth, entries)
        : offset + (x * depth) / 8
      const target = (y * width + x) * 4
      data[target] = image.readUInt8(source + 2)
      data[target + 1] = image.readUInt8(source + 1)
      data[target + 2] = image.readUInt8(source)
      data[target + 3] = depth === 32 ? image.readUInt8(source + 3) : 255
      hasAlpha ||= data[target + 3] !== 0
    }
  }
  if (!hasAlpha || depth !== 32) {
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const bit = image[mask + (height - y - 1) * maskStride + (x >> 3)] ?? 0
        data[(y * width + x) * 4 + 3] = bit & (0x80 >> (x % 8)) ? 0 : 255
      }
    }
  }
  return { width, height, data }
}

function paletteOffset(
  image: Buffer,
  row: number,
  x: number,
  depth: number,
  entries: number,
): number {
  const bit = x * depth
  const index = (image.readUInt8(row + (bit >> 3)) >> (8 - depth - (bit % 8))) & (2 ** depth - 1)
  if (index >= entries) throw new Error('Invalid ICO palette index')
  return 40 + index * 4
}

function resize({ width, height, data }: Pixels): Buffer {
  dimensions(width, height)
  const scale = SIZE / Math.max(width, height)
  const w = Math.max(1, Math.round(width * scale))
  const h = Math.max(1, Math.round(height * scale))
  const left = Math.floor((SIZE - w) / 2)
  const top = Math.floor((SIZE - h) / 2)
  const png = new PNG({ width: SIZE, height: SIZE, fill: true })
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const from =
        (Math.floor(((y + 0.5) * height) / h) * width + Math.floor(((x + 0.5) * width) / w)) * 4
      const to = ((y + top) * SIZE + x + left) * 4
      png.data.set(data.subarray(from, from + 4), to)
    }
  }
  const result = PNG.sync.write(png)
  if (result.length > MAX_PNG) throw new Error('Avatar PNG exceeds limit')
  return result
}

export async function decodeAvatar(bytes: Buffer, type: string): Promise<Buffer> {
  if (!bytes.length || bytes.length > MAX_INPUT) throw new Error('Invalid image size')
  switch (type) {
    case 'image/png':
      return resize(readPng(bytes))
    case 'image/jpeg':
      return resize(
        decode(bytes, {
          maxResolutionInMP: 1.05,
          maxMemoryUsageInMB: 32,
          tolerantDecoding: false,
        }),
      )
    case 'image/x-icon':
    case 'image/vnd.microsoft.icon':
      return resize(readIcon(bytes))
    case 'image/svg+xml':
      return resize(readPng(await rasterSvg(bytes, dimensions)))
    default:
      throw new Error('Unsupported avatar')
  }
}
