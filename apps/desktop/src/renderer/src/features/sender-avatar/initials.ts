const segmenter = new Intl.Segmenter('en', { granularity: 'grapheme' })
const colors = ['#304879', '#674074', '#235d54', '#884028', '#45562e', '#71405a'] as const

export function avatarInitials(address: string | null | undefined, name?: string | null) {
  const normalizedAddress = normalizedAvatarAddress(address)
  const text = name?.trim() || normalizedAddress.split('@')[0]?.replace(/[._+-]+/g, ' ') || ''
  const words = text.trim().split(/\s+/u)
  const first = (word: string) =>
    segmenter.segment(word)[Symbol.iterator]().next().value?.segment ?? ''
  const initials = (
    first(words[0] ?? '') + (words.length > 1 ? first(words.at(-1) ?? '') : '')
  ).toUpperCase()
  let hash = 0
  for (const char of normalizedAddress || text.toLowerCase())
    hash = (Math.imul(31, hash) + (char.codePointAt(0) ?? 0)) >>> 0
  return { initials: initials || '?', color: colors[hash % colors.length] ?? colors[0] }
}

function normalizedAvatarAddress(address: string | null | undefined): string {
  const normalized = address?.trim().toLowerCase() ?? ''
  const at = normalized.lastIndexOf('@')
  if (at < 1) return normalized
  try {
    const domain = new URL(`https://${normalized.slice(at + 1)}`).hostname
    return normalized.slice(0, at + 1) + domain
  } catch {
    return normalized
  }
}
