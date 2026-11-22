import { encode } from 'jpeg-js'
import { PNG } from 'pngjs'
import { expect, it } from 'vitest'
import { decodeAvatar } from './decode.ts'
import { rasterize } from './raster.ts'
import { validateSvg } from './svg.ts'

const svg = (inner: string, width = 16) =>
  Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="16">${inner}</svg>`)

it('re-encodes PNG, JPEG and ICO as bounded, fixed-size PNG', async () => {
  const pixels = new PNG({ width: 8, height: 16 })
  pixels.data.fill(255)
  const png = PNG.sync.write(pixels)
  const ico = Buffer.alloc(22)
  ico.writeUInt16LE(1, 2)
  ico.writeUInt16LE(1, 4)
  ico[6] = 8
  ico[7] = 16
  ico.writeUInt32LE(png.length, 14)
  ico.writeUInt32LE(22, 18)
  for (const [bytes, type] of [
    [png, 'image/png'],
    [encode(pixels).data, 'image/jpeg'],
    [Buffer.concat([ico, png]), 'image/x-icon'],
  ] as const) {
    const output = await decodeAvatar(bytes, type)
    expect(output.length).toBeLessThan(32 * 1024)
    const decoded = PNG.sync.read(output)
    expect(decoded).toMatchObject({ width: 64, height: 64 })
    const center = (32 * 64 + 32) * 4
    expect(decoded.data[center + 3]).toBe(255)
    expect(decoded.data[3]).toBe(0)
  }
  await expect(decodeAvatar(png, 'image/jpeg')).rejects.toThrow()
  await expect(
    decodeAvatar(PNG.sync.write(new PNG({ width: 1025, height: 2 })), 'image/png'),
  ).rejects.toThrow('dimensions')
})

it('rasterizes static SVG in the image worker', async () => {
  const logo = svg('<rect width="16" height="16" fill="#ff0000"/>')
  const png = await rasterize(logo, 'image/svg+xml', AbortSignal.timeout(3500))
  expect(PNG.sync.read(png).data.subarray(0, 4)).toEqual(Buffer.from([255, 0, 0, 255]))
})

it('rejects SVG with active content, external references, animation, or excessive dimensions', async () => {
  for (const input of [
    svg('<script/>'),
    svg('<rect onclick="click()"/>'),
    svg('<image href="https://fixture.dev/logo.png"/>'),
    svg('<path fill="url(https://fixture.dev/logo.svg)" d="M0 0"/>'),
    svg('<animate attributeName="fill"/>'),
    svg('<rect style="fill: red"/>'),
    svg('<title>&amp;</title>'),
    Buffer.concat([Buffer.from('<!DOCTYPE svg>'), svg('<rect/>')]),
    Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><rect></svg>'),
  ])
    expect(() => validateSvg(input)).toThrow()
  await expect(decodeAvatar(svg('<rect/>', 1025), 'image/svg+xml')).rejects.toThrow('dimensions')
})
