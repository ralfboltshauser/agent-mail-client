import type { Address } from '@amc/protocol'

/**
 * Parses an RFC 5322 address list such as `"Doe, Jane" <jane@x.com>, bob@y.com, Team: a@b.c;`.
 * Lenient on purpose: real mail is messy, and a bad header must never fail a sync.
 */
export function parseAddressList(value: string | null | undefined): Address[] {
  if (!value) return []
  const out: Address[] = []
  for (const part of splitTopLevel(value)) {
    const trimmed = part
      .trim()
      .replace(/^[^:<"]*:\s*/, (m) => (m.includes('@') ? m : ''))
      .replace(/;$/, '')
    if (!trimmed) continue
    const angle = /^(.*)<([^>]*)>\s*$/.exec(trimmed)
    if (angle) {
      const address = (angle[2] ?? '').trim()
      if (!address) continue
      out.push({ name: cleanName(angle[1] ?? ''), address })
      continue
    }
    const bare = trimmed.replace(/\s*\(([^)]*)\)\s*$/, '')
    const comment = /\(([^)]*)\)\s*$/.exec(trimmed)?.[1]
    if (bare.includes('@'))
      out.push({ name: comment ? cleanName(comment) : null, address: bare.trim() })
  }
  return out
}

export function parseAddress(value: string | null | undefined): Address | null {
  return parseAddressList(value)[0] ?? null
}

function splitTopLevel(value: string): string[] {
  const parts: string[] = []
  let current = ''
  let quoted = false
  let depth = 0
  for (let i = 0; i < value.length; i++) {
    const ch = value[i]
    if (ch === '\\' && quoted) {
      current += ch + (value[i + 1] ?? '')
      i++
      continue
    }
    if (ch === '"') quoted = !quoted
    else if (!quoted && (ch === '<' || ch === '(')) depth++
    else if (!quoted && (ch === '>' || ch === ')')) depth = Math.max(0, depth - 1)
    if (ch === ',' && !quoted && depth === 0) {
      parts.push(current)
      current = ''
    } else {
      current += ch
    }
  }
  parts.push(current)
  return parts
}

function cleanName(raw: string): string | null {
  const name = raw
    .trim()
    .replace(/^"(.*)"$/, '$1')
    .replace(/\\(.)/g, '$1')
    .trim()
  return name || null
}

/** Message-ID style header → the id without angle brackets. */
export function cleanMessageId(value: string | null | undefined): string | null {
  if (!value) return null
  const match = /<([^>]+)>/.exec(value)
  return (match?.[1] ?? value).trim() || null
}
