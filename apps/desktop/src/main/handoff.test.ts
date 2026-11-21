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

  const handoff = new Handoff()
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

it('converts the MCP thread link into an installed T3 deep link', () => {
  expect(t3NavigationLink('[Draft reply](t3-thread://v2/env/mcp:launch:123)')).toBe(
    't3code://threads/env/mcp%3Alaunch%3A123',
  )
})
