import type { SQLInputValue } from 'node:sqlite'

const addressFields = { from: 'from_json', to: 'to_json', cc: 'cc_json' } as const

/** Build a message-level predicate. Each value is bound, including literal FTS phrases. */
export function mailSearch(text: string) {
  const tokens = text.match(/(\w+:)?"[^"]*"|\S+/g) ?? []
  const terms: string[] = []
  const filters: string[] = []
  const values: SQLInputValue[] = []
  for (const [index, raw] of tokens.entries()) {
    const field = /^(from|to|cc|subject|after|before):/i.exec(raw)?.[1]?.toLowerCase()
    const input = field ? raw.slice(field.length + 1) : raw
    const value = input.replace(/^"|"$/g, '').trim()
    if (!value) {
      if (field) return null
      continue
    }
    if (field === 'from' || field === 'to' || field === 'cc') {
      const column = addressFields[field]
      const addresses = field === 'from' ? `json_array(json(m.${column}))` : `m.${column}`
      const address = "lower(json_extract(person.value, '$.address'))"
      const name = "lower(json_extract(person.value, '$.name'))"
      const match = value.includes('@')
        ? `${address} = lower(?)`
        : `(instr(${address}, lower(?)) > 0 OR instr(${name}, lower(?)) > 0)`
      filters.push(`EXISTS (SELECT 1 FROM json_each(${addresses}) person WHERE ${match})`)
      values.push(value)
      if (!value.includes('@')) values.push(value)
    } else if (field === 'after' || field === 'before') {
      const boundary = Date.parse(value)
      if (
        !/^\d{4}-\d\d-\d\d$/.test(value) ||
        !Number.isFinite(boundary) ||
        new Date(boundary).toISOString().slice(0, 10) !== value
      )
        return null
      filters.push(field === 'after' ? 'm.sent_at >= ?' : 'm.sent_at < ?')
      values.push(boundary)
    } else {
      const term = `"${value.replace(/"/g, '""')}"`
      const prefix = !field && !input.startsWith('"') && index === tokens.length - 1
      terms.push(field === 'subject' ? `subject : ${term}` : prefix ? `${term}*` : term)
    }
  }
  if (!terms.length && !filters.length) return null
  return { match: terms.join(' AND '), filters, values }
}
