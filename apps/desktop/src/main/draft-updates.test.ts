import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { ComposePatch } from '@amc/protocol'
import { expect, it, vi } from 'vitest'
import * as Y from 'yjs'
import { DraftRecoveryPending, LocalDraftUpdates } from './draft-updates'
import { Replica } from './replica'

it('persists a pending body change through an offline flush and replays it on restart', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'amc-pending-draft-'))
  const path = join(dir, 'replica.db')
  const doc = new Y.Doc()
  doc.getText().insert(0, 'Typed just before closing')
  const patch = {
    baseRevision: 3,
    update: Buffer.from(Y.encodeStateAsUpdate(doc)).toString('base64'),
  }
  let replica = new Replica(path)
  try {
    replica.draftUpdates.stage('draft', patch)
    const request = vi.fn().mockRejectedValueOnce(new Error('Offline'))
    await replica.draftUpdates.flush({ request })
    replica.db.close()

    replica = new Replica(path)
    const engineDoc = new Y.Doc()
    request.mockImplementationOnce(async (_path, init: { body: ComposePatch }) => {
      Y.applyUpdate(engineDoc, Buffer.from(init.body.update, 'base64'))
    })
    await replica.draftUpdates.flush({ request })
    expect(engineDoc.getText().toString()).toBe('Typed just before closing')
    await replica.draftUpdates.flush({ request })
    expect(request).toHaveBeenCalledTimes(2)
  } finally {
    replica.db.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

it('clears staged updates for a discarded draft while keeping other drafts', async () => {
  const replica = new Replica(':memory:')
  try {
    const patch = { baseRevision: 3, update: 'AAA=' }
    replica.draftUpdates.stage('discarded', patch)
    replica.draftUpdates.stage('kept', patch)
    replica.draftUpdates.discard('discarded')
    const request = vi.fn().mockResolvedValue(undefined)
    await replica.draftUpdates.flush({ request })
    expect(request).toHaveBeenCalledExactlyOnceWith(
      '/v1/compose/drafts/kept',
      expect.objectContaining({ method: 'PUT', body: patch }),
    )
  } finally {
    replica.db.close()
  }
})

it('keeps a draft closed while its staged changes cannot be replayed and retries that draft alone', async () => {
  const replica = new Replica(':memory:')
  try {
    const updates = replica.draftUpdates
    const patch = { baseRevision: 3, update: 'AAA=' }
    updates.stage('opening', patch)
    updates.stage('other', patch)
    const request = vi.fn().mockRejectedValueOnce(new Error('Offline')).mockResolvedValue(undefined)
    await expect(updates.recover({ request }, 'opening')).rejects.toBeInstanceOf(
      DraftRecoveryPending,
    )
    await expect(updates.recover({ request }, 'opening')).resolves.toBe(true)
    await expect(updates.recover({ request }, 'opening')).resolves.toBe(false)
    expect(request.mock.calls.map(([path]) => path)).toEqual([
      '/v1/compose/drafts/opening',
      '/v1/compose/drafts/opening',
    ])
    await expect(updates.recover({ request }, 'other')).resolves.toBe(true)
  } finally {
    replica.db.close()
  }
})

it('replays a body update staged by an older desktop version', async () => {
  const db = new DatabaseSync(':memory:')
  try {
    db.exec(`CREATE TABLE draft_update (
      id TEXT PRIMARY KEY, revision INTEGER NOT NULL, body TEXT NOT NULL
    ) STRICT;
    INSERT INTO draft_update VALUES ('draft', 3, 'AAA=')`)
    const updates = new LocalDraftUpdates(db)
    const request = vi.fn().mockResolvedValue(undefined)
    await updates.flush({ request })
    expect(request).toHaveBeenCalledExactlyOnceWith(
      '/v1/compose/drafts/draft',
      expect.objectContaining({ body: { baseRevision: 3, update: 'AAA=' } }),
    )
  } finally {
    db.close()
  }
})

it('keeps a newer header edit with the same body when an older save completes', async () => {
  const replica = new Replica(':memory:')
  try {
    const first = {
      baseRevision: 3,
      update: 'AAA=',
      fields: {
        accountId: 'account',
        to: [],
        cc: [],
        bcc: [],
        subject: 'First',
        attachmentIds: [],
      },
    }
    const latest = { ...first, fields: { ...first.fields, subject: 'Latest' } }
    replica.draftUpdates.stage('draft', first)
    replica.draftUpdates.stage('draft', latest)
    replica.draftUpdates.acknowledge('draft', first)
    const request = vi.fn().mockResolvedValue(undefined)
    await replica.draftUpdates.flush({ request })
    expect(request).toHaveBeenCalledExactlyOnceWith(
      '/v1/compose/drafts/draft',
      expect.objectContaining({ body: latest }),
    )
  } finally {
    replica.db.close()
  }
})
