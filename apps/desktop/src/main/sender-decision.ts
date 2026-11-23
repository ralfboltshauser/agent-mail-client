import type { OwnerActionStatus, SenderDecision } from '@amc/protocol'
import { type EngineClient, EngineError } from './engine'

export async function submitSenderDecision(
  engine: { request: (...args: Parameters<EngineClient['request']>) => Promise<OwnerActionStatus> },
  input: SenderDecision,
  isCurrent: () => boolean,
) {
  const post = (body: SenderDecision) =>
    engine.request('/v1/senders/decisions', {
      method: 'POST',
      body,
      signal: AbortSignal.timeout(10_000),
    })
  try {
    return await post(input)
  } catch (error) {
    if (
      !(error instanceof EngineError) ||
      error.status !== 409 ||
      error.code !== 'sender_revision_conflict' ||
      typeof error.currentRevision !== 'number' ||
      !Number.isSafeInteger(error.currentRevision) ||
      error.currentRevision < 0
    )
      throw error
    if (!isCurrent()) throw new Error('The Engine pairing changed')
    // Keep the original action ID and request revision so a lost reply remains replayable.
    return post({ ...input, retryRevision: error.currentRevision })
  }
}
