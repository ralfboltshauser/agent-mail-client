// Replica replies are structured-cloned JSON. Reuse unchanged branches, even when rows move.
export function shareReply<T>(previous: T | undefined, next: T): T {
  return share(previous, next) as T
}

function record(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object') return false
  const prototype: object | null = Object.getPrototypeOf(value)
  return prototype === null || Object.getPrototypeOf(prototype) === null
}

function rowId(value: unknown): string | undefined {
  return record(value) && typeof value.id === 'string' ? value.id : undefined
}

function share(previous: unknown, next: unknown): unknown {
  if (Object.is(previous, next)) return previous
  if (Array.isArray(previous) && Array.isArray(next)) {
    let rowsById: Map<string | undefined, unknown> | undefined
    let unchanged = previous.length === next.length
    const rows = next.map((row, index) => {
      const id = rowId(row)
      const prior = previous[index]
      if (id !== undefined && id !== rowId(prior)) {
        rowsById ??= new Map(previous.map((item) => [rowId(item), item]))
      }
      const shared = share(id !== undefined && rowsById ? rowsById.get(id) : prior, row)
      if (!Object.is(shared, prior)) unchanged = false
      return shared
    })
    return unchanged ? previous : rows
  }
  if (!record(previous) || !record(next)) return next

  const keys = Object.keys(next)
  let unchanged = keys.length === Object.keys(previous).length
  const shared = { ...next }
  for (const key of keys) {
    if (!Object.hasOwn(previous, key)) {
      unchanged = false
      continue
    }
    const value = share(previous[key], next[key])
    shared[key] = value
    if (!Object.is(previous[key], value)) unchanged = false
  }
  return unchanged ? previous : shared
}
