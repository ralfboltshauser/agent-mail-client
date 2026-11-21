import { createHash, randomUUID } from 'node:crypto'
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs'
import { mkdir, rename, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { type Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'

/** Content-addressed store on the big disk: raw mail, HTML bodies, attachments (plan §4.2). */
export class BlobStore {
  readonly root: string

  constructor(root: string) {
    this.root = root
  }

  put(data: Uint8Array | string): string {
    const bytes = typeof data === 'string' ? Buffer.from(data, 'utf8') : data
    const hash = createHash('sha256').update(bytes).digest('hex')
    const path = this.path(hash)
    if (!existsSync(path)) {
      mkdirSync(dirname(path), { recursive: true })
      const tmp = `${path}.${process.pid}.tmp`
      writeFileSync(tmp, bytes)
      renameSync(tmp, path)
    }
    return hash
  }

  async putStream(
    source: Readable,
    expectedSize?: number,
  ): Promise<{ hash: string; size: number }> {
    const hash = createHash('sha256')
    const tmp = join(this.root, `stream-${randomUUID()}.tmp`)
    let size = 0
    const meter = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        size += chunk.length
        if (expectedSize !== undefined && size > expectedSize) {
          return callback(new Error('Blob size differs from the expected size'))
        }
        hash.update(chunk)
        callback(null, chunk)
      },
    })
    try {
      await mkdir(this.root, { recursive: true })
      await pipeline(source, meter, createWriteStream(tmp, { flags: 'wx' }))
      if (expectedSize !== undefined && size !== expectedSize) {
        throw new Error('Blob size differs from the expected size')
      }
      const digest = hash.digest('hex')
      const path = this.path(digest)
      if (!existsSync(path)) {
        await mkdir(dirname(path), { recursive: true })
        await rename(tmp, path)
      }
      return { hash: digest, size }
    } finally {
      await rm(tmp, { force: true })
    }
  }

  get(hash: string): Buffer | null {
    if (!/^[0-9a-f]{64}$/.test(hash)) return null
    try {
      return readFileSync(this.path(hash))
    } catch {
      return null
    }
  }

  path(hash: string): string {
    return join(this.root, hash.slice(0, 2), hash.slice(2, 4), hash)
  }
}
