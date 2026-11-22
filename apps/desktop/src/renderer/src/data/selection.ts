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
