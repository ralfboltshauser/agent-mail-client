import type { Logger } from '@amc/observability'
import type { IpcMainInvokeEvent, WebContents } from 'electron'
import { rendererReport } from '../shared/failure'

export function ownMainFrame(
  event: Pick<IpcMainInvokeEvent, 'sender' | 'senderFrame'>,
  contents: WebContents | undefined,
  url: string | undefined,
): boolean {
  const frame = event.senderFrame
  return (
    !!url &&
    !!frame &&
    event.sender === contents &&
    frame === event.sender.mainFrame &&
    frame.url === url
  )
}

const windowMs = 60_000
const limit = 40

export function limitRendererReports(logger: () => Logger, now = Date.now) {
  let start = now()
  let accepted = 0
  let dropped = 0
  return (value: unknown) => {
    const current = now()
    if (current - start >= windowMs) {
      if (dropped)
        logger().log('warn', 'renderer.failures.dropped', {
          count: dropped,
          windowMs: current - start,
        })
      start = current
      accepted = 0
      dropped = 0
    }
    if (accepted >= limit) {
      dropped++
      return
    }
    const report = rendererReport(value)
    if (!report) return
    accepted++
    const { source, errorClass, requestId, runId } = report
    logger().log('error', 'renderer.failure', { source, errorClass }, { requestId, runId })
  }
}
