import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Seals provider credentials (OAuth refresh tokens, IMAP passwords) at rest with AES-256-GCM.
 * The 32-byte key lives in the secrets directory, readable by the Engine only (ADR 0003).
 */
export class Sealer {
  readonly #key: Buffer

  constructor(key: Buffer) {
    if (key.length !== 32) throw new Error('The encryption key must be 32 bytes')
    this.#key = key
  }

  static fromSecretsDir(dir: string): Sealer {
    const path = join(dir, 'key')
    let key: Buffer
    try {
      key = readFileSync(path)
    } catch {
      throw new Error(
        `Missing encryption key at ${path}. Create it with: sudo -u amc sh -c 'head -c 32 /dev/urandom > ${path} && chmod 600 ${path}'`,
      )
    }
    return new Sealer(key)
  }

  seal(value: unknown): Buffer {
    const iv = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', this.#key, iv)
    const body = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()])
    return Buffer.concat([Buffer.from([1]), iv, cipher.getAuthTag(), body])
  }

  open<T>(sealed: Uint8Array): T {
    const buf = Buffer.from(sealed)
    if (buf[0] !== 1) throw new Error('Unknown sealed format')
    const iv = buf.subarray(1, 13)
    const tag = buf.subarray(13, 29)
    const decipher = createDecipheriv('aes-256-gcm', this.#key, iv)
    decipher.setAuthTag(tag)
    const plain = Buffer.concat([decipher.update(buf.subarray(29)), decipher.final()])
    return JSON.parse(plain.toString('utf8')) as T
  }
}
