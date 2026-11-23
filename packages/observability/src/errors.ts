export const errorClasses = [
  'Error',
  'TypeError',
  'RangeError',
  'SyntaxError',
  'ReferenceError',
  'AggregateError',
  'AbortError',
  'TimeoutError',
  'HTTPException',
  'EngineError',
  'SenderError',
  'DraftError',
  'DraftRevisionConflict',
  'AccountConflict',
  'ZodError',
  'UnknownError',
  'NonError',
] as const

const errorCodes = [
  'EACCES',
  'EADDRINUSE',
  'ECONNREFUSED',
  'ECONNRESET',
  'EEXIST',
  'EHOSTUNREACH',
  'EIO',
  'ENOENT',
  'ENOSPC',
  'EPERM',
  'ETIMEDOUT',
  'ERR_SQLITE_ERROR',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_SOCKET',
  'ABORT_ERR',
  'internal',
  'unreachable',
  'unauthorized',
  'forbidden',
  'bad_request',
] as const

// These phrases are owned by AMC or come from a fixed runtime error. Arbitrary
// prose could contain unmarked mailbox data, even after pattern-based redaction.
const messages = [
  'fetch failed',
  'Failed to fetch',
  'The operation was aborted',
  'This operation was aborted',
  'The operation was aborted due to timeout',
  'Something went wrong in the Engine',
  'Event stream refused',
] as const

export function sanitizeErrorMessage(value: unknown): string {
  if (typeof value !== 'string') return '[redacted]'
  const candidate = value
    .slice(0, 256)
    .replace(/\b[\w.!#$%&'*+/=?^`{|}~-]+@[\w.-]+\.[a-z]{2,}\b/gi, '[redacted]')
    .replace(/"[^"\r\n]{12,}"|'[^'\r\n]{12,}'|`[^`\r\n]{12,}`/g, '[redacted]')
    .replace(
      /\b(?:bearer|basic)\s+\S+|\b(?:[\w-]*token|authorization|password|client_secret)\s*[:=]\s*\S+|\b[a-z0-9_+/=-]{24,}\b/gi,
      '[redacted]',
    )
    .trim()
  // A matching prefix must not turn an overlong message into an allowed phrase.
  return value.length <= 256 ? (known(messages, candidate) ?? '[redacted]') : '[redacted]'
}

function known<T extends string>(values: readonly T[], value: unknown): T | undefined {
  return values.find((entry) => entry === value)
}

export type ErrorClass = (typeof errorClasses)[number]
export type ErrorCode = (typeof errorCodes)[number]

export interface SafeError {
  class: ErrorClass
  code?: ErrorCode
  message: string
  stack: StackFrame[]
}

interface StackFrame {
  file: string
  line: number
  column: number
}

/** Keys are exact V8 frame paths or file URLs. Values are static source labels. */
export type OwnStackFiles = ReadonlyMap<string, string>

function ownFrames(stack: unknown, files: OwnStackFiles): StackFrame[] {
  if (typeof stack !== 'string' || !files.size) return []
  const frames: StackFrame[] = []
  for (const line of stack.slice(0, 8192).split('\n').slice(1)) {
    const frame =
      /^\s+at (?:.*? \()?((?:file:\/\/|\/|[a-z]:\\)[^\r\n()]+):(\d{1,7}):(\d{1,7})\)?$/i.exec(line)
    if (!frame?.[1]) continue
    const file = files.get(frame[1])
    if (file !== undefined) frames.push({ file, line: Number(frame[2]), column: Number(frame[3]) })
    if (frames.length === 8) break
  }
  return frames
}

export function sanitizeError(error: unknown, files: OwnStackFiles = new Map()): SafeError {
  try {
    if (!(error instanceof Error)) return { class: 'NonError', message: '[redacted]', stack: [] }
    // Some subclasses leave .name as Error, so consult the constructor as well.
    const errorClass =
      known(errorClasses, Object.getPrototypeOf(error)?.constructor?.name) ??
      known(errorClasses, error.name) ??
      'UnknownError'
    const code = known(errorCodes, (error as Error & { code?: unknown }).code)
    return {
      class: errorClass,
      ...(code ? { code } : {}),
      message: sanitizeErrorMessage(error.message),
      stack: ownFrames(error.stack, files),
    }
  } catch {
    // Error fields can be getters or a Proxy can throw during inspection.
    return { class: 'UnknownError', message: '[redacted]', stack: [] }
  }
}
