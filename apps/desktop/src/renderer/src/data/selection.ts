/** Memoize the selected snapshot React compares before scheduling a render. */
export function selectedSnapshot<Snapshot, Value>(
  read: () => Snapshot,
  select: (snapshot: Snapshot) => Value,
  equal: (left: Value, right: Value) => boolean = Object.is,
  committed?: () => { value: Value } | undefined,
): () => Value {
  let current: { snapshot: Snapshot; value: Value } | undefined
  return () => {
    const snapshot = read()
    if (current && Object.is(current.snapshot, snapshot)) return current.value
    const value = select(snapshot)
    const previous = current ?? committed?.()
    current = { snapshot, value: previous && equal(previous.value, value) ? previous.value : value }
    return current.value
  }
}

/** Preserve the nearest surviving neighbour when the active Inbox row disappears. */
export function inboxSelectionFallback(
  prior: readonly string[] | undefined,
  next: readonly string[],
  id: string | null,
): string | null {
  const index = id === null ? -1 : (prior?.indexOf(id) ?? -1)
  if (!prior || index < 0) return next[0] ?? null
  const visible = new Set(next)
  for (let i = index + 1; i < prior.length; i++) {
    if (visible.has(prior[i])) return prior[i]
  }
  for (let i = index - 1; i >= 0; i--) {
    if (visible.has(prior[i])) return prior[i]
  }
  return next[0] ?? null
}
