import { parentPort, workerData } from 'node:worker_threads'
import { decodeAvatar } from './decode.ts'

void decodeAvatar(Buffer.from(workerData.bytes), workerData.type).then(
  (png) => parentPort?.postMessage(png),
  () => parentPort?.postMessage(null),
)
