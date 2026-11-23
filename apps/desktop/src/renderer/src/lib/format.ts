import type { Address } from '@amc/protocol'

const time = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' })
const dayMonth = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' })
const full = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' })
const weekday = new Intl.DateTimeFormat(undefined, { weekday: 'short' })

/** List dates the way mail clients do: time today, weekday this week, date this year, else year. */
export function listDate(ms: number, now = new Date()): string {
  const d = new Date(ms)
  if (d.toDateString() === now.toDateString()) return time.format(d)
  const days = (now.getTime() - ms) / 86_400_000
  if (days < 6) return weekday.format(d)
  if (d.getFullYear() === now.getFullYear()) return dayMonth.format(d)
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
}

export function fullDate(ms: number): string {
  return full.format(new Date(ms))
}

export function personName(a: Address | null | undefined): string {
  if (!a) return 'Unknown'
  return a.name?.trim() || a.address.split('@')[0] || a.address
}

export function firstName(a: Address): string {
  const name = personName(a)
  return name.split(/[\s,]+/)[0] ?? name
}

/** "Alice, Bob, me" style list for the Thread list, short when there are many. */
export function participantsLine(people: Address[], self: Set<string>): string {
  const names = people.map((p) =>
    self.has(p.address.toLowerCase()) ? 'me' : people.length > 2 ? firstName(p) : personName(p),
  )
  if (names.length <= 3) return names.join(', ')
  return `${names.slice(0, 2).join(', ')} +${names.length - 2}`
}

export function fileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 ** 2) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / 1024 ** 2).toFixed(1)} MB`
}
