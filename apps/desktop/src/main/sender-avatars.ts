import { createHash } from 'node:crypto'
import type { SenderAvatarResolve, SenderAvatarResults } from '@amc/protocol'
import type { DesktopSenderAvatarResults } from '../shared/api'
import type { EngineClient } from './engine'
import { operationFailure } from './observability'

const digestPattern = /^[a-f0-9]{64}$/
const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
const maxBytes = 32 * 1024
const imagePrefix = 'data:image/png;base64,'
const key = (row: { accountId: string; messageId: string }) =>
  JSON.stringify([row.accountId, row.messageId])

class AvatarCache {
  readonly #images = new Map<string, string>()
  readonly #loading = new Map<string, Promise<string | null>>()

  async resolve(
    engine: EngineClient,
    input: SenderAvatarResolve,
    known: ReadonlySet<string>,
  ): Promise<DesktopSenderAvatarResults> {
    const signal = AbortSignal.timeout(5_000)
    const response = await engine.request<SenderAvatarResults>('/v1/sender-avatars/resolve', {
      method: 'POST',
      body: input,
      signal,
      redirect: 'error',
    })
    const requested = new Set(input.messages.map(key))
    const rows = response.rows.filter((row) => requested.delete(key(row)))
    const images = new Map<string, string | null>()
    const digests = Array.from(
      new Set(
        rows.flatMap(({ digest, source }) =>
          source !== 'initials' && digest && digestPattern.test(digest) && !known.has(digest)
            ? [digest]
            : [],
        ),
      ),
    )
    for (let offset = 0; offset < digests.length && !signal.aborted; offset += 4) {
      await Promise.all(
        digests.slice(offset, offset + 4).map(async (digest) => {
          images.set(digest, await this.#image(engine, digest, signal))
        }),
      )
    }
    return {
      rows: rows.map((row) => ({
        ...row,
        ...(row.digest && images.has(row.digest) ? { image: images.get(row.digest) ?? null } : {}),
      })),
    }
  }

  #image(engine: EngineClient, digest: string, deadline: AbortSignal): Promise<string | null> {
    const cached = this.#images.get(digest)
    if (cached) {
      this.#images.delete(digest)
      this.#images.set(digest, cached)
      return Promise.resolve(cached)
    }
    const pending = this.#loading.get(digest)
    if (pending) return pending
    if (this.#loading.size >= 4) return Promise.resolve(null)
    const task = readPng(engine, digest, AbortSignal.any([deadline, AbortSignal.timeout(3_000)]))
      .then((image) => {
        if (image) {
          this.#images.set(digest, image)
          if (this.#images.size > 256) {
            const oldest = this.#images.keys().next().value
            if (oldest) this.#images.delete(oldest)
          }
        }
        return image
      })
      .finally(() => this.#loading.delete(digest))
    this.#loading.set(digest, task)
    return task
  }
}

async function readPng(
  engine: EngineClient,
  digest: string,
  signal: AbortSignal,
): Promise<string | null> {
  try {
    const res = await engine.authenticatedGet(`/v1/sender-avatars/${digest}`, signal)
    if (
      !res.ok ||
      res.headers.get('Content-Type') !== 'image/png' ||
      Number(res.headers.get('Content-Length')) > maxBytes ||
      !res.body
    ) {
      await res.body?.cancel()
      return null
    }
    const reader = res.body.getReader()
    const chunks: Uint8Array[] = []
    let length = 0
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        length += value.byteLength
        if (length > maxBytes) return null
        chunks.push(value)
      }
    } finally {
      await reader.cancel()
    }
    const bytes = Buffer.concat(chunks, length)
    if (
      bytes.length < 33 ||
      !bytes.subarray(0, 8).equals(signature) ||
      bytes.toString('ascii', 12, 16) !== 'IHDR' ||
      bytes.readUInt32BE(16) !== 64 ||
      bytes.readUInt32BE(20) !== 64 ||
      createHash('sha256').update(bytes).digest('hex') !== digest
    )
      return null
    return imagePrefix + bytes.toString('base64')
  } catch (error) {
    operationFailure('sender-avatar', error)
    return null
  }
}

const caches = new WeakMap<EngineClient, AvatarCache>()

export function resolveSenderAvatars(
  engine: EngineClient,
  input: SenderAvatarResolve,
  knownDigests: unknown,
): Promise<DesktopSenderAvatarResults> {
  const known =
    Array.isArray(knownDigests) && knownDigests.length <= 100
      ? new Set<string>(
          knownDigests.filter((value) => typeof value === 'string' && digestPattern.test(value)),
        )
      : new Set<string>()
  let cache = caches.get(engine)
  if (!cache) {
    cache = new AvatarCache()
    caches.set(engine, cache)
  }
  return cache.resolve(engine, input, known)
}
