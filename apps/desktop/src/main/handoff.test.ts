import type { ComposeDraft } from '@amc/protocol'
import { expect, it, vi } from 'vitest'
import type { EngineClient } from './engine'
import { Handoff, t3NavigationLink } from './handoff'

it('launches the chosen T3 project with scoped context and retries a lost response with the same payload', async () => {
  const draft = { id: 'draft-1' } as ComposeDraft
  const composerUrl = 'https://engine.example.test/compose/draft-1#token=synthetic'
  const request = vi
    .fn()
    .mockResolvedValueOnce({ draftId: draft.id, composerUrl, agentToken: 'synthetic-grant' })
    .mockResolvedValueOnce({ saved: true })
  const engine = {
    baseUrl: 'https://engine.example.test',
    request,
    get: vi.fn().mockResolvedValue(draft),
  } as unknown as EngineClient
  const launch = vi
    .fn()
    .mockRejectedValueOnce(new Error('lost response'))
    .mockResolvedValueOnce({ threadId: 'new-t3-thread' })

  using db = new DatabaseSync(':memory:')
  const handoff = new Handoff(db)
  await expect(handoff.launch(engine, 'project-1', 'mail-thread', launch)).rejects.toThrow(
    'lost response',
  )
  await expect(handoff.launch(engine, 'project-1', 'mail-thread', launch)).resolves.toEqual({
    draft,
    thread: { threadId: 'new-t3-thread' },
  })
  const payload = launch.mock.calls[0]?.[0]
  expect(launch.mock.calls[1]?.[0]).toEqual(payload)
  expect(payload).toMatchObject({
    projectId: 'project-1',
    runtimeMode: 'approval-required',
    workspaceStrategy: { type: 'root' },
  })
  expect(payload.message).toContain('mail-thread')
  expect(payload.message).toContain('draft-1')
  expect(payload.message).toContain('https://engine.example.test/mcp')
  expect(payload.message).toContain(composerUrl)
  expect(payload.message).toContain('Authorization: Bearer synthetic-grant')
  expect(request).toHaveBeenCalledTimes(2)
  expect(request).toHaveBeenLastCalledWith(`/v1/compose/handoff/${payload.clientRequestId}`, {
    method: 'PUT',
    body: { t3ThreadId: 'new-t3-thread' },
  })
})

it.each(['Engine POST', 'T3 launch', 'Engine confirmation'])(
  'recovers a lost %s reply after reopening the desktop database',
  async (lostReply) => {
    const dir = mkdtempSync(join(tmpdir(), 'amc-handoff-'))
    const path = join(dir, 'replica.db')
    let id = ''
    const response = {
      draftId: 'draft-1',
      composerUrl: 'https://engine.example.test/compose/draft-1#token=synthetic',
      agentToken: 'synthetic-grant',
    }
    const request = vi.fn(async (_path, init) => {
      if (init.method === 'POST') {
        id = init.body.requestId
        if (lostReply === 'Engine POST') throw new Error('lost response')
        return response
      }
      if (init.method === 'PUT') throw new Error('lost response')
      return { cancelled: true }
    })
    const engine = {
      baseUrl: 'https://engine.example.test',
      request,
    } as unknown as EngineClient
    const launch = vi.fn(async () => {
      if (lostReply === 'T3 launch') throw new Error('lost response')
      return { threadId: 't3-thread' }
    })
    try {
      {
        using db = new DatabaseSync(path)
        await expect(
          new Handoff(db).launch(engine, 'project-1', 'mail-thread', launch),
        ).rejects.toThrow('lost response')
        expect(db.prepare('SELECT * FROM pending_handoff').all()).toEqual([
          { id, engine_url: engine.baseUrl },
        ])
      }
      {
        using db = new DatabaseSync(path)
        const restarted = new Handoff(db)
        request.mockRejectedValueOnce(new Error('offline'))
        await expect(restarted.recover(engine)).rejects.toThrow('offline')
        expect(db.prepare('SELECT id FROM pending_handoff').all()).toEqual([{ id }])
        await restarted.recover(engine)
        expect(request).toHaveBeenLastCalledWith(
          `/v1/compose/handoff/${id}?pending=1`,
          expect.objectContaining({ method: 'DELETE' }),
        )
        expect(db.prepare('SELECT id FROM pending_handoff').all()).toEqual([])
        expect(launch).toHaveBeenCalledTimes(lostReply === 'Engine POST' ? 0 : 1)
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  },
)

it('ends the saved hand-off after a successful stubbed launch', async () => {
  using db = new DatabaseSync(':memory:')
  const request = vi.fn().mockResolvedValue({
    draftId: 'draft-1',
    composerUrl: 'https://engine.example.test/compose/draft-1#token=synthetic',
    agentToken: 'synthetic-grant',
  })
  const get = vi.fn().mockResolvedValueOnce({ id: 'draft-1' })
  const engine = { baseUrl: 'https://engine.example.test', request, get } as unknown as EngineClient
  const launch = vi.fn().mockResolvedValue({ threadId: 't3-thread' })
  const handoff = new Handoff(db)
  await handoff.launch(engine, 'project-1', 'mail-thread', launch)
  const id = launch.mock.calls[0]?.[0].clientRequestId
  get.mockResolvedValueOnce({ active: { id } })
  expect(await handoff.active(engine, 'mail-thread')).toEqual({ id })
  await handoff.end(engine, id)
  expect(request).toHaveBeenLastCalledWith(`/v1/compose/handoff/${id}`, { method: 'DELETE' })
})

it('converts the MCP thread link into an installed T3 deep link', () => {
  expect(t3NavigationLink('[Draft reply](t3-thread://v2/env/mcp:launch:123)')).toBe(
    't3code://threads/env/mcp%3Alaunch%3A123',
  )
})

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
