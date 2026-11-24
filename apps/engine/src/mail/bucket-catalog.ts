import { randomUUID } from 'node:crypto'
import {
  BUILT_IN_BUCKETS,
  type BucketCatalog,
  type BucketDefinition,
  type BucketId,
  type BucketStorageKey,
  type CreateBucket,
  CustomBucketId,
  MAX_CUSTOM_BUCKETS,
  type ReorderBuckets,
  type UpdateBucket,
} from '@amc/protocol'
import type { z } from 'zod'
import type { Principal } from '../auth/tokens.ts'
import { type Db, transaction } from '../db/database.ts'
import { assertOwner } from './senders/actions.ts'
import type { MailStore } from './store.ts'

type BucketErrorCode =
  | 'invalid_bucket'
  | 'bucket_conflict'
  | 'bucket_archived'
  | 'bucket_missing'
  | 'upgrade_required'

export class BucketError extends Error {
  readonly code: BucketErrorCode
  readonly status: 400 | 404 | 409
  readonly revision: number | undefined
  constructor(code: BucketErrorCode, message: string, status: 400 | 404 | 409, revision?: number) {
    super(message)
    this.code = code
    this.status = status
    this.revision = revision
  }
}

interface CustomRow {
  id: z.infer<typeof CustomBucketId>
  name: string
  normalized_name: string
  description: string
  automatic: number
  archived: number
  classification_revision: number
  create_input: string
}

const normalizeName = (name: string) => name.normalize('NFKC').toLowerCase()
const reservedNames = new Set(['clear', ...BUILT_IN_BUCKETS.map(({ name }) => normalizeName(name))])

function rows(db: Db) {
  return db
    .prepare('SELECT * FROM custom_bucket ORDER BY position, id')
    .all() as unknown as CustomRow[]
}

function definition(row: CustomRow): BucketDefinition {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    builtIn: false,
    archived: Boolean(row.archived),
    automatic: Boolean(row.automatic),
    classificationRevision: row.classification_revision,
  }
}

export function catalogRevision(db: Db): number {
  return Number(db.prepare('SELECT revision FROM bucket_catalog WHERE id = 1').get()?.revision)
}

export function readCatalog(db: Db): BucketCatalog {
  return transaction(db, () => ({
    revision: catalogRevision(db),
    definitions: [...BUILT_IN_BUCKETS, ...rows(db).map(definition)],
  }))
}

function bump(store: MailStore) {
  store.db.prepare('UPDATE bucket_catalog SET revision = revision + 1 WHERE id = 1').run()
  store.recordChange('bucket_catalog', '1', 'upsert')
}

function assertRevision(db: Db, expected: number) {
  const current = catalogRevision(db)
  if (current !== expected)
    throw new BucketError(
      'bucket_conflict',
      'The Bucket catalog changed. Reload it and retry.',
      409,
      current,
    )
}

function checkName(db: Db, name: string, id?: string) {
  const key = normalizeName(name)
  const existing = db.prepare('SELECT id FROM custom_bucket WHERE normalized_name = ?').get(key)
  if (reservedNames.has(key) || (existing && existing.id !== id))
    throw new BucketError(
      'bucket_conflict',
      'A Bucket already uses that name.',
      409,
      catalogRevision(db),
    )
  return key
}

function checkDescription(automatic: boolean, description: string) {
  if (automatic && !description)
    throw new BucketError(
      'invalid_bucket',
      'Describe when automatic triage should use this Bucket.',
      400,
    )
}

export function createBucket(
  store: MailStore,
  principal: Principal,
  input: z.infer<typeof CreateBucket>,
) {
  const { db } = store
  return transaction(db, () => {
    assertOwner(db, principal)
    const { name, description, automatic, requestId } = input
    const fingerprint = JSON.stringify([name, description, automatic])
    const existing = db
      .prepare('SELECT * FROM custom_bucket WHERE request_id = ?')
      .get(requestId) as CustomRow | undefined
    if (existing) {
      if (existing.create_input !== fingerprint)
        throw new BucketError('bucket_conflict', 'The create request ID was already used.', 409)
      return { definition: definition(existing), catalog: readCatalog(db) }
    }
    const stats = db
      .prepare(
        'SELECT count(*) AS count, coalesce(max(position), -1) AS position FROM custom_bucket',
      )
      .get()
    if (Number(stats?.count) >= MAX_CUSTOM_BUCKETS)
      throw new BucketError('invalid_bucket', 'The custom Bucket limit has been reached.', 400)
    const normalizedName = checkName(db, name)
    checkDescription(automatic, description)
    const id = `bucket.custom.${randomUUID()}` as CustomRow['id']
    db.prepare(`
      INSERT INTO custom_bucket VALUES (?, ?, ?, ?, ?, 0, ?, 1, ?, ?)
    `).run(
      id,
      name,
      normalizedName,
      description,
      Number(automatic),
      Number(stats?.position) + 1,
      requestId,
      fingerprint,
    )
    bump(store)
    return { definition: definition(customRow(db, id)), catalog: readCatalog(db) }
  })
}

function customRow(db: Db, id: string) {
  const row = db.prepare('SELECT * FROM custom_bucket WHERE id = ?').get(id) as
    | CustomRow
    | undefined
  if (!row) throw new BucketError('bucket_missing', 'Custom Bucket not found.', 404)
  return row
}

export function updateBucket(
  store: MailStore,
  principal: Principal,
  id: string,
  input: z.infer<typeof UpdateBucket>,
) {
  const { db } = store
  return transaction(db, () => {
    assertOwner(db, principal)
    assertRevision(db, input.expectedRevision)
    const before = customRow(db, id)
    const name = input.name ?? before.name
    const description = input.description ?? before.description
    const archived = input.archived ?? Boolean(before.archived)
    const transitioning = archived !== Boolean(before.archived)
    if ((archived || transitioning) && input.automatic)
      throw new BucketError(
        'invalid_bucket',
        'Restore the Bucket before enabling automatic assignment.',
        400,
      )
    const automatic =
      archived || transitioning ? false : (input.automatic ?? Boolean(before.automatic))
    checkDescription(automatic, description)
    const classificationChanged =
      description !== before.description || transitioning || Number(automatic) !== before.automatic
    if (name !== before.name || classificationChanged) {
      const normalizedName = checkName(db, name, id)
      db.prepare(`
        UPDATE custom_bucket SET name = ?, normalized_name = ?, description = ?, automatic = ?,
          archived = ?, classification_revision = classification_revision + ? WHERE id = ?
      `).run(
        name,
        normalizedName,
        description,
        Number(automatic),
        Number(archived),
        Number(classificationChanged),
        id,
      )
      bump(store)
    }
    return readCatalog(db)
  })
}

export function reorderBuckets(
  store: MailStore,
  principal: Principal,
  input: z.infer<typeof ReorderBuckets>,
) {
  const { db } = store
  return transaction(db, () => {
    assertOwner(db, principal)
    assertRevision(db, input.expectedRevision)
    const current = rows(db)
      .filter((row) => !row.archived)
      .map(({ id }) => id)
    const { ids } = input
    if (
      ids.length !== current.length ||
      new Set(ids).size !== ids.length ||
      ids.some((id) => !current.includes(id))
    )
      throw new BucketError('invalid_bucket', 'Supply every active custom Bucket ID once.', 400)
    if (ids.some((id, index) => id !== current[index])) {
      const setPosition = db.prepare('UPDATE custom_bucket SET position = ? WHERE id = ?')
      const ordered = [
        ...ids,
        ...rows(db)
          .filter((row) => row.archived)
          .map(({ id }) => id),
      ]
      for (const [index, id] of ordered.entries()) setPosition.run(index, id)
      bump(store)
    }
    return readCatalog(db)
  })
}

export function assignableBucketKey(
  db: Db,
  id: z.infer<typeof BucketId> | null,
): BucketStorageKey | null {
  if (id === null) return null
  const builtin = BUILT_IN_BUCKETS.find((item) => item.id === id)
  if (builtin) return builtin.name as BucketStorageKey
  const row = customRow(db, id)
  if (row.archived) throw new BucketError('bucket_archived', 'This Bucket is archived.', 409)
  return row.id
}

export function guardLegacyBucket(current: string | null | undefined, idAware: boolean) {
  if (!idAware && CustomBucketId.safeParse(current).success)
    throw new BucketError(
      'upgrade_required',
      'Upgrade this Client before changing a custom Bucket assignment.',
      409,
    )
}
