import { Worker } from 'node:worker_threads'
import { AvatarLookupError, bounded } from './network.ts'

declare const AMC_AVATAR_WORKER: string

export async function rasterize(bytes: Buffer, type: string, signal: AbortSignal): Promise<Buffer> {
  if (signal.aborted) throw new AvatarLookupError('transient')
  const entry =
    typeof AMC_AVATAR_WORKER === 'string'
      ? AMC_AVATAR_WORKER
      : new URL('./decode-worker.ts', import.meta.url)
  const worker = new Worker(entry, {
    eval: typeof AMC_AVATAR_WORKER === 'string',
    execArgv: [],
    workerData: { bytes, type },
    resourceLimits: { maxOldGenerationSizeMb: 48, maxYoungGenerationSizeMb: 12, stackSizeMb: 2 },
  })
  try {
    return await bounded(
      new Promise<Buffer>((resolve, reject) => {
        worker.once('message', (result: Uint8Array | null) => {
          if (result) resolve(Buffer.from(result))
          else reject(new AvatarLookupError('unsafe'))
        })
        worker.once('error', () => reject(new AvatarLookupError('unsafe')))
        worker.once('exit', () => reject(new AvatarLookupError('unsafe')))
      }),
      signal,
    )
  } finally {
    await worker.terminate()
  }
}
