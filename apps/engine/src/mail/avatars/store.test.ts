import { DatabaseSync } from 'node:sqlite'
import { expect, it } from 'vitest'
import { SqliteAvatarIndex } from './store.ts'

it('retains recently read entries, evicts older entries and clears on database replacement', () => {
  const db = new DatabaseSync(':memory:')
  try {
    const index = new SqliteAvatarIndex(db, 'original')
    for (let i = 0; i < 513; i++) {
      if (i === 512) expect(index.get('sender-0.dev', 'favicon')?.outcome).toBe('miss')
      index.put(`sender-${i}.dev`, 'favicon', {
        asset: null,
        outcome: 'miss',
        fetchedAt: 1,
        retryAt: 2,
        serveUntil: 0,
        failures: 0,
      })
    }
    expect(index.get('sender-0.dev', 'favicon')).not.toBeNull()
    expect(index.get('sender-1.dev', 'favicon')).toBeNull()
    expect(new SqliteAvatarIndex(db, 'original').get('sender-0.dev', 'favicon')).not.toBeNull()
    expect(new SqliteAvatarIndex(db, 'restored').get('sender-0.dev', 'favicon')).toBeNull()
  } finally {
    db.close()
  }
})
