import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { ComposeDraft } from '@amc/protocol'
import { expect, it, vi } from 'vitest'
import type { EngineClient } from './engine'
import { Handoff, t3NavigationLink } from './handoff'
import { cliLauncher } from './t3-cli'

it('launches the chosen T3 project with scoped context and retries confirmation without launching again', async () => {
  const draft = { id: 'draft-1' } as ComposeDraft
  const composerUrl = 'https://engine.example.test/compose/draft-1#token=synthetic'
  const request = vi
    .fn()
    .mockResolvedValueOnce({ draftId: draft.id, composerUrl, agentToken: 'synthetic-grant' })
    .mockRejectedValueOnce(new Error('lost confirmation response'))
    .mockResolvedValueOnce({ saved: true })
  const engine = {
    baseUrl: 'https://engine.example.test',
    request,
    get: vi.fn().mockResolvedValue(draft),
  } as unknown as EngineClient
  const launch = vi.fn().mockResolvedValue({ threadId: 'new-t3-thread' })

  using db = new DatabaseSync(':memory:')
  const handoff = new Handoff(db)
  await expect(handoff.launch(engine, 'project-1', 'mail-thread', launch)).rejects.toThrow(
    'lost confirmation response',
  )
  await expect(handoff.launch(engine, 'project-1', 'mail-thread', launch)).resolves.toEqual({
    draft,
    thread: { threadId: 'new-t3-thread' },
  })
  const payload = launch.mock.calls[0]?.[0]
  expect(launch).toHaveBeenCalledTimes(1)
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
  expect(request).toHaveBeenCalledTimes(3)
  expect(request).toHaveBeenLastCalledWith(`/v1/compose/handoff/${payload.clientRequestId}`, {
    method: 'PUT',
    body: { t3ThreadId: 'new-t3-thread' },
  })
})

it.each([
  ['the environment ID is missing', null],
  ['the executable cannot start', { code: 'ENOENT' }],
  ['thread start exits non-zero', { code: 1 }],
  ['thread start times out', { killed: true, signal: 'SIGTERM' }],
] as const)('revokes the pending handoff when %s', async (_failure, cliError) => {
  const baseDir = mkdtempSync(join(tmpdir(), 'amc-handoff-cli-'))
  try {
    using db = new DatabaseSync(':memory:')
    const response = {
      draftId: 'draft-1',
      composerUrl: 'https://engine.example.test/compose/draft-1#token=synthetic',
      agentToken: 'synthetic-grant',
    }
    const request = vi
      .fn()
      .mockResolvedValueOnce(response)
      .mockResolvedValueOnce({ cancelled: true })
    const draft = { id: response.draftId } as ComposeDraft
    const engine = {
      baseUrl: 'https://engine.example.test',
      request,
      get: vi.fn().mockResolvedValue(draft),
    } as unknown as EngineClient
    const executable = join(baseDir, 'bin', 't3')
    const run = vi.fn().mockResolvedValueOnce('[]')
    if (cliError) {
      mkdirSync(join(baseDir, 'userdata'))
      writeFileSync(join(baseDir, 'userdata', 'environment-id'), 'local-env')
      run.mockRejectedValueOnce(Object.assign(new Error('t3 failed'), cliError))
    }
    const launch = cliLauncher({ executable, baseDir }, run).launch
    const handoff = new Handoff(db)

    await expect(handoff.launch(engine, 'project-1', 'mail-thread', launch)).rejects.toThrow(
      'T3 could not confirm the launch.',
    )

    const id = request.mock.calls[0]?.[1].body.requestId
    expect(run.mock.calls.map(([, args]) => args[1])).toEqual(cliError ? ['list', 'start'] : [])
    expect(request.mock.calls.map(([, init]) => init.method)).toEqual(['POST', 'DELETE'])
    expect(request).toHaveBeenLastCalledWith(
      `/v1/compose/handoff/${id}?pending=1`,
      expect.objectContaining({ method: 'DELETE' }),
    )
    expect(db.prepare('SELECT id FROM pending_handoff').all()).toEqual([])

    const retryLaunch = vi.fn().mockResolvedValue({ threadId: 'new-t3-thread' })
    request.mockResolvedValueOnce(response).mockResolvedValueOnce({ saved: true })
    await expect(handoff.launch(engine, 'project-1', 'mail-thread', retryLaunch)).resolves.toEqual({
      draft,
      thread: { threadId: 'new-t3-thread' },
    })
    expect(retryLaunch.mock.calls[0]?.[0].clientRequestId).not.toBe(id)
  } finally {
    rmSync(baseDir, { recursive: true, force: true })
  }
})

it.each(['Engine POST', 'launch cleanup', 'Engine confirmation'])(
  'recovers after %s fails and the desktop database is reopened',
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
      if (lostReply === 'launch cleanup') throw new Error('offline')
      return { cancelled: true }
    })
    const engine = {
      baseUrl: 'https://engine.example.test',
      request,
    } as unknown as EngineClient
    const launch = vi.fn(async () => {
      if (lostReply === 'launch cleanup') throw new Error('lost response')
      return { threadId: 't3-thread' }
    })
    try {
      {
        using db = new DatabaseSync(path)
        await expect(
          new Handoff(db).launch(engine, 'project-1', 'mail-thread', launch),
        ).rejects.toThrow('lost response')
        if (lostReply === 'launch cleanup') {
          expect(request).toHaveBeenLastCalledWith(
            `/v1/compose/handoff/${id}?pending=1`,
            expect.objectContaining({ method: 'DELETE' }),
          )
        }
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
        request.mockResolvedValueOnce({ cancelled: true })
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
