export interface Migration {
  version: number
  name: string
  sql: string
}

/**
 * Append-only. Never edit a migration that has shipped; add a new one.
 * The schema version is kept in SQLite's `user_version`.
 */
export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: 'auth and settings',
    sql: `
      CREATE TABLE token (
        id           TEXT PRIMARY KEY,
        kind         TEXT NOT NULL CHECK (kind IN ('desktop', 'cli', 'agent', 'composer')),
        name         TEXT NOT NULL,
        scopes       TEXT NOT NULL,           -- JSON array of scopes
        subject      TEXT,                    -- composer tokens: the one draft they may edit
        hash         TEXT NOT NULL UNIQUE,    -- sha256 of the secret; the secret itself is never stored
        created_at   INTEGER NOT NULL,
        last_used_at INTEGER,
        expires_at   INTEGER,
        revoked_at   INTEGER
      ) STRICT;

      CREATE TABLE pairing_code (
        hash        TEXT PRIMARY KEY,
        kind        TEXT NOT NULL CHECK (kind IN ('desktop', 'cli')),
        created_at  INTEGER NOT NULL,
        expires_at  INTEGER NOT NULL,
        used_at     INTEGER
      ) STRICT;

      CREATE TABLE setting (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL                   -- JSON
      ) STRICT;
    `,
  },
]
