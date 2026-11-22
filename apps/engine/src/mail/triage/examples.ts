import type { Db } from '../../db/database.ts'
import type { messageFeatures } from './annotations.ts'

type Features = ReturnType<typeof messageFeatures>

export function readEffective(
  db: Db,
  accountId: string,
  generation: number,
  input: {
    arrival: string
    features: Features
  },
) {
  return db
    .prepare(`
    SELECT e.id, e.axis, e.label_id AS labelId, e.features_json AS features
    FROM triage_event e
    WHERE e.account_id = ?1 AND e.account_generation = ?2 AND e.kind = 'decision'
      AND e.axis IN ('bucket', 'filter') AND e.arrival_key IS NOT NULL AND e.arrival_key != ?3
      AND (e.features_json ->> 'senderHash' = ?4 OR e.features_json ->> 'listId' = ?5
        OR e.features_json ->> 'domain' = ?6)
      AND NOT EXISTS (
        SELECT 1 FROM triage_event u WHERE u.target_event_id = e.id AND u.kind = 'undo')
      AND NOT EXISTS (
        SELECT 1 FROM triage_event newer
        WHERE newer.account_id = e.account_id AND newer.account_generation = e.account_generation
          AND newer.axis = e.axis AND newer.subject_key = e.subject_key AND newer.seq > e.seq
          AND newer.kind = 'decision' AND NOT EXISTS (
            SELECT 1 FROM triage_event u WHERE u.target_event_id = newer.id AND u.kind = 'undo'))
    ORDER BY (
      8 * coalesce(e.features_json ->> 'senderHash' = ?4, 0)
      + 4 * coalesce(e.features_json ->> 'listId' = ?5, 0)
      + 2 * coalesce(e.features_json ->> 'domain' = ?6, 0)
    ) * pow(0.5, max(0, ?7 - e.created_at) / 5184000000.0) DESC,
    (e.features_json ->> 'category' = ?8) DESC, e.seq DESC
    LIMIT 4
  `)
    .all({
      1: accountId,
      2: generation,
      3: input.arrival,
      4: input.features.senderHash,
      5: input.features.listId,
      6: input.features.domain,
      7: Date.now(),
      8: input.features.category,
    }) as { id: string; axis: string; labelId: string; features: string }[]
}

export function retrieveExamples(
  db: Db,
  accountId: string,
  generation: number,
  inputs: {
    arrival: string
    features: Features
    threadId: string
  }[],
) {
  const targets: Record<string, string[]> = Object.create(null)
  const examples: { id: string; axis: string; labelId: string; features: Features }[] = []
  for (const input of inputs) {
    const selected: string[] = []
    targets[input.threadId] = selected
    for (const { features, ...example } of readEffective(db, accountId, generation, input)) {
      const fresh = !examples.some(({ id }) => id === example.id)
      if (fresh && examples.length === 12) continue
      if (fresh) examples.push({ ...example, features: JSON.parse(features) })
      selected.push(example.id)
      if (Buffer.byteLength(JSON.stringify({ targets, examples })) > 3072) {
        selected.pop()
        if (fresh) examples.pop()
      }
    }
    if (!selected.length) delete targets[input.threadId]
  }
  return { targets, examples }
}
