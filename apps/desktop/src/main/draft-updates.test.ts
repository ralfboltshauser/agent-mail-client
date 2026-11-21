import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ComposePatch } from '@amc/protocol'
import { expect, it, vi } from 'vitest'
import * as Y from 'yjs'
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
