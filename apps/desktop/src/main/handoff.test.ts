import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { expect, it, vi } from 'vitest'
import type { EngineClient } from './engine'
import { Handoff, type T3Launch, type T3Launcher, type T3Thread, t3NavigationLink } from './handoff'

function launcherFor(launch: T3Launcher['launch']): T3Launcher {
  return { key: 'fixture', projects: async () => [], launch }
}

it('closes an unlaunched Engine request after restart', async () => {
  using db = new DatabaseSync(':memory:')
  // Existing installations can have rows without launch metadata.
  db.exec(`CREATE TABLE pending_handoff (id TEXT PRIMARY KEY, engine_url TEXT NOT NULL);
    INSERT INTO pending_handoff VALUES ('old-request', 'https://engine.example.test');`)
  const request = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue({})
  const engine = { baseUrl: 'https://engine.example.test', request } as unknown as EngineClient
  const restarted = new Handoff(db)

  await expect(restarted.recover(engine)).rejects.toThrow('offline')
  expect(db.prepare('SELECT id FROM pending_handoff').all()).toEqual([{ id: 'old-request' }])
  await restarted.recover(engine)
  expect(request).toHaveBeenLastCalledWith(
    '/v1/compose/handoff/old-request?pending=1',
    expect.objectContaining({ method: 'DELETE' }),
  )
  expect(db.prepare('SELECT id FROM pending_handoff').all()).toEqual([])
})

it.each(['T3 launch reply', 'Engine confirmation'])(
  'leaves the handoff available to end after losing the %s and retries with a fresh launch',
  async (lostReply) => {
    const dir = mkdtempSync(join(tmpdir(), 'amc-handoff-'))
    const path = join(dir, 'replica.db')
    const draft = { id: 'draft-1' }
    const previousThread = { threadId: 'previous-t3-thread' }
    const thread = { threadId: 'new-t3-thread' }
    const request = vi.fn().mockResolvedValueOnce({
      draftId: draft.id,
      composerUrl: 'https://engine.example.test/compose/draft-1#token=previous',
      agentToken: 'previous-grant',
    })
    const launch = vi.fn<(request: T3Launch) => Promise<T3Thread>>()
    if (lostReply === 'T3 launch reply') {
      launch.mockRejectedValueOnce(new Error('lost response'))
    } else {
      launch.mockResolvedValueOnce(previousThread)
      request.mockRejectedValueOnce(new Error('lost response'))
    }
    const composerUrl = 'https://engine.example.test/compose/draft-1#token=synthetic'
    request
      .mockResolvedValueOnce({ draftId: draft.id, composerUrl, agentToken: 'synthetic-grant' })
      .mockResolvedValueOnce({ saved: true })
    launch.mockResolvedValueOnce(thread)
    const engine = {
      baseUrl: 'https://engine.example.test',
      request,
      get: vi.fn().mockResolvedValue(draft),
    } as unknown as EngineClient
    const launcher = launcherFor(launch)

    try {
      {
        using db = new DatabaseSync(path)
        await expect(
          new Handoff(db).launch(engine, 'project-1', 'mail-thread', launcher),
        ).rejects.toThrow('lost response')
        const rows = db.prepare('SELECT launch FROM pending_handoff').all()
        expect(rows).toEqual([{ launch: 'dispatched' }])
        // A previous version could store a thread ID obtained from a title match.
        db.prepare('UPDATE pending_handoff SET launch = ?').run(
          JSON.stringify({
            launchId: launch.mock.calls[0]?.[0].clientRequestId,
            thread: previousThread,
          }),
        )
      }
      const callsBeforeRetry = lostReply === 'T3 launch reply' ? ['POST'] : ['POST', 'PUT']
      expect(request.mock.calls.map(([, init]) => init.method)).toEqual(callsBeforeRetry)
      {
        using db = new DatabaseSync(path)
        const restarted = new Handoff(db)
        await restarted.recover(engine)
        expect(request).toHaveBeenCalledTimes(callsBeforeRetry.length)
        await expect(
          restarted.launch(engine, 'project-1', 'mail-thread', launcher),
        ).resolves.toEqual({ draft, thread })
        expect(db.prepare('SELECT id FROM pending_handoff').all()).toEqual([])
      }

      expect(launch).toHaveBeenCalledTimes(2)
      const payload = launch.mock.calls[1]?.[0]
      expect(payload).toMatchObject({
        projectId: 'project-1',
        title: 'Draft an AMC reply',
        runtimeMode: 'approval-required',
        workspaceStrategy: { type: 'root' },
      })
      expect(payload?.clientRequestId).not.toBe(launch.mock.calls[0]?.[0].clientRequestId)
      for (const context of [
        'mail-thread',
        'draft-1',
        'https://engine.example.test/mcp',
        composerUrl,
        'Authorization: Bearer synthetic-grant',
      ]) {
        expect(payload?.message).toContain(context)
      }
      const engineId = request.mock.calls[callsBeforeRetry.length]?.[1].body.requestId
      expect(engineId).not.toBe(request.mock.calls[0]?.[1].body.requestId)
      expect(request.mock.calls.map(([, init]) => init.method)).toEqual([
        ...callsBeforeRetry,
        'POST',
        'PUT',
      ])
      expect(request).toHaveBeenLastCalledWith(`/v1/compose/handoff/${engineId}`, {
        method: 'PUT',
        body: { t3ThreadId: thread.threadId },
      })
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
  await handoff.launch(engine, 'project-1', 'mail-thread', launcherFor(launch))
  const id = request.mock.calls[0]?.[1].body.requestId
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
