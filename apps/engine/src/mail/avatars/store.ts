import { chmodSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { Logger } from '../../log.ts'
import type { AvatarAsset, AvatarSource, LookupOutcome } from './index.ts'

export interface CacheEntry {
  asset: AvatarAsset | null
  outcome: LookupOutcome
  fetchedAt: number
  retryAt: number
  serveUntil: number
  failures: number
}

export interface AvatarIndex {
  get(domain: string, source: AvatarSource): CacheEntry | null
  put(domain: string, source: AvatarSource, entry: CacheEntry): void
  image(digest: string, now: number, bimiDomain?: string): Uint8Array | null
}

const MAX_ENTRIES = 512

interface Row {
  digest: string | null
  png: Uint8Array | null
  outcome: LookupOutcome
  fetched_at: number
  retry_at: number
  serve_until: number
  failures: number
}

export function openAvatarIndex(dataDir: string, databasePath: string, log: Logger): AvatarIndex {
  const filename = join(dataDir, 'sender-avatars-v1.db')
  let db: DatabaseSync | undefined
  try {
    const { dev, ino, birthtimeMs } = statSync(databasePath)
    db = new DatabaseSync(filename)
    chmodSync(filename, 0o600)
    db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL')
    return new SqliteAvatarIndex(db, `${dev}:${ino}:${birthtimeMs}`)
  } catch {
    db?.close()
    log.warn('using disposable in-memory sender avatar cache')
    return new SqliteAvatarIndex(new DatabaseSync(':memory:'))
  }
}

export class SqliteAvatarIndex implements AvatarIndex {
  #sequence: number
  readonly #db: DatabaseSync
  constructor(db: DatabaseSync, generation = '') {
    this.#db = db
    db.exec(`
      CREATE TABLE IF NOT EXISTS avatar_generation (id TEXT PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS avatar (
        domain TEXT NOT NULL, source TEXT NOT NULL, digest TEXT, png BLOB,
        outcome TEXT NOT NULL, fetched_at INTEGER NOT NULL,
        retry_at INTEGER NOT NULL, serve_until INTEGER NOT NULL,
        failures INTEGER NOT NULL, touched INTEGER NOT NULL,
        PRIMARY KEY (domain, source)
      );
      CREATE INDEX IF NOT EXISTS avatar_digest ON avatar (digest, source, domain);
      CREATE INDEX IF NOT EXISTS avatar_lru ON avatar(touched);
    `)
    // The mail database is replaced on restore. Discard the old avatar index at that boundary.
    if (!db.prepare('SELECT id FROM avatar_generation WHERE id = ?').get(generation)) {
      db.exec('BEGIN')
      try {
        db.exec('DELETE FROM avatar; DELETE FROM avatar_generation')
        db.prepare('INSERT INTO avatar_generation VALUES (?)').run(generation)
        db.exec('COMMIT')
      } catch (error) {
        db.exec('ROLLBACK')
        throw error
      }
    }
    this.#sequence = Number(db.prepare('SELECT max(touched) AS n FROM avatar').get()?.n ?? 0)
  }

  get(domain: string, source: AvatarSource): CacheEntry | null {
    const row = this.#db
      .prepare('SELECT * FROM avatar WHERE domain = ? AND source = ?')
      .get(domain, source) as Row | undefined
    if (!row) return null
    this.#db
      .prepare('UPDATE avatar SET touched = ? WHERE domain = ? AND source = ?')
      .run(++this.#sequence, domain, source)
    return {
      asset: row.digest && row.png ? { digest: row.digest, png: row.png } : null,
      outcome: row.outcome,
      fetchedAt: row.fetched_at,
      retryAt: row.retry_at,
      serveUntil: row.serve_until,
      failures: row.failures,
    }
  }

  put(domain: string, source: AvatarSource, entry: CacheEntry): void {
    this.#db
      .prepare(`INSERT OR REPLACE INTO avatar VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(
        domain,
        source,
        entry.asset?.digest ?? null,
        entry.asset?.png ?? null,
        entry.outcome,
        entry.fetchedAt,
        entry.retryAt,
        entry.serveUntil,
        entry.failures,
        ++this.#sequence,
      )
    this.#db
      .prepare(`DELETE FROM avatar WHERE rowid IN (
      SELECT rowid FROM avatar ORDER BY touched DESC LIMIT -1 OFFSET ?
    )`)
      .run(MAX_ENTRIES)
  }

  image(digest: string, now: number, bimiDomain?: string): Uint8Array | null {
    const row = this.#db
      .prepare(`SELECT rowid, png FROM avatar
      WHERE digest = ? AND serve_until > ? AND (source = 'favicon' OR domain = ?)
      ORDER BY touched DESC LIMIT 1`)
      .get(digest, now, bimiDomain ?? '') as { rowid: number; png: Uint8Array } | undefined
    if (!row) return null
    this.#db
      .prepare('UPDATE avatar SET touched = ? WHERE rowid = ?')
      .run(++this.#sequence, row.rowid)
    return row.png
  }
}
