import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

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
