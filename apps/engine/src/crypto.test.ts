import { randomBytes } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { Sealer } from './crypto.ts'

describe('Sealer', () => {
  it('round-trips and detects tampering', () => {
    const sealer = new Sealer(randomBytes(32))
    const sealed = sealer.seal({ refreshToken: 'secret' })
    expect(sealed.toString()).not.toContain('secret')
    expect(sealer.open(sealed)).toEqual({ refreshToken: 'secret' })
    sealed.writeUInt8((sealed.at(-1) ?? 0) ^ 1, sealed.length - 1)
    expect(() => sealer.open(sealed)).toThrow()
  })

  it('refuses a different key', () => {
    const sealed = new Sealer(randomBytes(32)).seal('x')
    expect(() => new Sealer(randomBytes(32)).open(sealed)).toThrow()
  })
})
