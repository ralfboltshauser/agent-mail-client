import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'

/** A random, URL-safe secret with a readable prefix, e.g. `amc_…`. */
export function newSecret(prefix: string, bytes = 32): string {
  return `${prefix}_${randomBytes(bytes).toString('base64url')}`
}

export function newId(prefix: string): string {
  return `${prefix}_${randomBytes(9).toString('base64url')}`
}

export function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a)
  const y = Buffer.from(b)
  return x.length === y.length && timingSafeEqual(x, y)
}

/** A short pairing code that is easy to type: 4+4 characters, no look-alikes. */
export function newPairingCode(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  const bytes = randomBytes(8)
  let code = ''
  for (let i = 0; i < 8; i++) code += alphabet[(bytes[i] ?? 0) % alphabet.length]
  return `${code.slice(0, 4)}-${code.slice(4)}`
}
