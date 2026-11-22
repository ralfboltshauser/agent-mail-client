import type { Address } from '@amc/protocol'
import { parseAddressList } from '../addresses.ts'
import { normalizeSender } from './index.ts'

/** Accept a single mailbox. The general mail parser deliberately tolerates partial lists. */
export function senderMailbox(value: string | undefined): Address | null {
  if (!value) return null
  let quoted = false
  let comment = 0
  let angle = false
  let hadAngle = false
  let bareAddress = false
  for (let i = 0; i < value.length; i++) {
    const char = value[i]
    if (char === '\\' && (quoted || comment)) {
      i++
      continue
    }
    if (char === '"' && !comment) quoted = !quoted
    if (quoted) continue
    if (char === '(') comment++
    if (comment) {
      if (char === ')') comment--
      continue
    }
    if (char === '<') {
      if (hadAngle || bareAddress) return null
      hadAngle = true
      angle = true
    } else if (char === '>') {
      if (!angle) return null
      angle = false
    } else if (char === '@' && !angle) {
      if (hadAngle) return null
      bareAddress = true
    } else if (char === ',' || char === ':' || char === ';' || char === ')') {
      return null
    }
  }
  if (quoted || comment || angle) return null
  const [mailbox, extra] = parseAddressList(value)
  return mailbox && !extra && normalizeSender(mailbox.address) ? mailbox : null
}
