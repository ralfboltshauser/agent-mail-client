import { type NativeImage, nativeImage } from 'electron'
import type { FeedbackAnnotation } from '../shared/feedback'

// A compact bitmap font keeps PNG rendering in main and works without a display or font lookup.
const digits = [
  '111101101101111',
  '010110010010111',
  '111001111100111',
  '111001111001111',
  '101101111001001',
  '111100111001111',
  '111100111101111',
  '111001001001001',
  '111101111101111',
  '111101111001111',
]

export function markFeedbackImage(
  image: NativeImage,
  annotations: FeedbackAnnotation[],
  viewport: { width: number; height: number },
) {
  const scaleFactor = Math.max(...image.getScaleFactors())
  const { width, height } = image.getSize(scaleFactor)
  const bitmap = image.toBitmap({ scaleFactor })
  const scale = Math.max(1, Math.round(scaleFactor))
  const pixel = (x: number, y: number, white: boolean) => {
    const offset = (y * width + x) * 4
    bitmap[offset] = white ? 255 : 49
    bitmap[offset + 1] = white ? 255 : 51
    bitmap[offset + 2] = white ? 255 : 190
    bitmap[offset + 3] = 255
  }
  annotations.forEach(({ bounds }, index) => {
    const label = String(index + 1)
    const markerWidth = (label.length * 8 + 7) * scale
    const markerHeight = 18 * scale
    if (markerWidth > width || markerHeight > height) return
    const x = Math.max(
      0,
      Math.min(width - markerWidth, Math.round((bounds.x * width) / viewport.width)),
    )
    const y = Math.max(
      0,
      Math.min(height - markerHeight, Math.round((bounds.y * height) / viewport.height)),
    )
    for (let dy = 0; dy < markerHeight; dy++) {
      for (let dx = 0; dx < markerWidth; dx++) {
        const gx = Math.floor(dx / scale) - 4
        const gy = Math.floor(dy / scale) - 4
        const character = label[Math.floor(gx / 8)]
        const column = Math.floor((gx % 8) / 2)
        const row = Math.floor(gy / 2)
        const white =
          gx >= 0 &&
          gy >= 0 &&
          column < 3 &&
          row < 5 &&
          digits[Number(character)]?.[row * 3 + column] === '1'
        pixel(x + dx, y + dy, white)
      }
    }
  })
  return nativeImage.createFromBitmap(bitmap, { width, height }).toPNG()
}
