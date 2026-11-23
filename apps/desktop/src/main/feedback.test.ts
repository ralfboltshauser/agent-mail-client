import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  feedbackCaptureLifetimeMs,
  feedbackMessage,
  launchFeedback,
  saveFeedbackCapture,
  saveFeedbackExcerpt,
} from './feedback'
import type { T3Launch } from './handoff'
import { launchT3Feedback } from './t3'

vi.mock('electron', () => ({ app: {}, shell: {} }))

const context = {
  at: new Date('2026-11-22T20:00:00Z'),
  version: '0.1.0 abc123',
  view: 'inbox',
  width: 1360,
  height: 860,
}
const request: T3Launch = {
  projectId: 'synthetic-project',
  title: 'AMC feedback',
  clientRequestId: 'fixture',
  runtimeMode: 'approval-required',
  workspaceStrategy: { type: 'root' },
  message: 'Synthetic feedback',
}
const empty = { text: '', markdown: '' }
let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'amc-feedback-test-'))
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

describe('feedback captures', () => {
  it('writes private PNGs, keeps the newest 20 and ignores unrelated files', () => {
    const directory = join(root, 'feedback')
    mkdirSync(directory)
    chmodSync(directory, 0o755)
    writeFileSync(join(directory, 'other.png'), 'unrelated')
    const captures = Array.from({ length: 23 }, (_, index) =>
      saveFeedbackCapture(root, Buffer.from([index]), new Date(context.at.getTime() + index)),
    )
    expect(statSync(directory).mode & 0o777).toBe(0o700)
    expect(statSync(captures[22]).mode & 0o777).toBe(0o600)
    expect(readFileSync(captures[22])).toEqual(Buffer.from([22]))
    expect(readdirSync(directory).sort()).toEqual(
      [...captures.slice(3).map((path) => path.split('/').at(-1)), 'other.png'].sort(),
    )
  })

  it('stores only projected log metadata and expires excerpts with screenshots', async () => {
    const screenshot = saveFeedbackCapture(root, Buffer.from('synthetic'), context.at)
    const logDir = join(root, 'logs')
    mkdirSync(logDir)
    const canary = 'synthetic-owner-reason example@example.test https://canary.invalid/path'
    writeFileSync(
      join(logDir, 'main.log'),
      [
        `{ malformed ${canary}`,
        JSON.stringify({
          ts: context.at.toISOString(),
          component: 'main',
          level: 'warn',
          event: 'feedback.launch.failed',
          stage: 'LaunchFailed',
          msg: canary,
          ownerReason: canary,
        }),
        '',
      ].join('\n'),
    )
    const excerpt = await saveFeedbackExcerpt(screenshot, logDir, context.at)
    expect(statSync(excerpt).mode & 0o777).toBe(0o600)
    const text = readFileSync(excerpt, 'utf8')
    expect(text).toContain('feedback.launch.failed')
    expect(text).not.toContain(canary)
    saveFeedbackCapture(
      root,
      Buffer.from('synthetic'),
      new Date(context.at.getTime() + feedbackCaptureLifetimeMs),
    )
    expect(readdirSync(join(root, 'feedback'))).toHaveLength(1)
  })

  it('passes Agentation markdown verbatim and only includes allowlisted window context', () => {
    const markdown = '## AMC\ndiv > button\n**Selected text:** Fixture\n**Feedback:** Add spacing'
    const message = feedbackMessage(
      { text: 'General note', markdown },
      {
        ...context,
        view: 'search with private data',
        ...{ address: 'private address', body: 'private body', sender: 'private sender' },
      },
    )
    expect(message).toContain('General note')
    expect(message).toContain(markdown)
    expect(message).toContain(
      'Context: AMC 0.1.0 abc123, view unknown, window 1360×860, 2026-11-22T20:00:00.000Z',
    )
    expect(message).not.toContain('private')
  })
})

describe('T3 feedback launch', () => {
  const endpoint = new URL('http://127.0.0.1:3773/mcp')
  const target = '/api/attachments/upload/fixture'
  const path = () => saveFeedbackCapture(root, Buffer.from([1, 2, 3]), context.at)

  function client(uploadUrl?: string, capabilities = true) {
    const listTools = vi.fn().mockResolvedValue({
      tools: capabilities
        ? [
            { name: 't3_thread_launch', inputSchema: { properties: { attachments: {} } } },
            { name: 't3_attachment_prepare_upload' },
          ]
        : [],
    })
    const callTool = vi
      .fn()
      .mockResolvedValueOnce({
        structuredContent: capabilities
          ? { attachmentId: 'image-id', relativeUrl: target, uploadUrl }
          : { threadId: 'new-thread' },
      })
      .mockResolvedValue({ structuredContent: { threadId: 'new-thread' } })
    return { listTools, callTool }
  }

  it('passes the screenshot to the attachment-capable launcher', async () => {
    const launch = vi.fn().mockResolvedValue({ threadId: 'new-thread' })
    const screenshot = path()
    await launchFeedback(
      { key: 'test', projects: async () => [], launch },
      request.projectId,
      request.clientRequestId,
      empty,
      context,
      screenshot,
    )
    expect(launch).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'AMC feedback',
        projectId: request.projectId,
        clientRequestId: 'fixture',
        message: expect.not.stringContaining(screenshot),
      }),
      screenshot,
    )
  })

  it('uploads exact PNG bytes and uses the attachment on the initial message', async () => {
    const mcp = client()
    const fetchUpload = vi.fn().mockResolvedValue({ ok: true })
    const screenshot = path()
    await expect(
      launchT3Feedback(mcp, endpoint, request, screenshot, fetchUpload),
    ).resolves.toEqual({ threadId: 'new-thread' })
    const metadata = {
      type: 'image',
      name: screenshot.split('/').at(-1),
      mimeType: 'image/png',
      sizeBytes: 3,
    }
    expect(mcp.callTool).toHaveBeenNthCalledWith(
      1,
      {
        name: 't3_attachment_prepare_upload',
        arguments: { upload: metadata },
      },
      undefined,
      expect.anything(),
    )
    expect(fetchUpload).toHaveBeenCalledWith(
      new URL(target, endpoint),
      expect.objectContaining({
        method: 'POST',
        body: Buffer.from([1, 2, 3]),
        redirect: 'error',
      }),
    )
    expect(mcp.callTool).toHaveBeenNthCalledWith(
      2,
      {
        name: 't3_thread_launch',
        arguments: { ...request, attachments: [{ id: 'image-id', ...metadata }] },
      },
      undefined,
      expect.anything(),
    )
  })

  it('uses a local path on an older MCP server', async () => {
    const mcp = client(undefined, false)
    const fetchUpload = vi.fn()
    const screenshot = path()
    await launchT3Feedback(mcp, endpoint, request, screenshot, fetchUpload)
    expect(fetchUpload).not.toHaveBeenCalled()
    expect(mcp.callTool).toHaveBeenCalledExactlyOnceWith(
      {
        name: 't3_thread_launch',
        arguments: { ...request, message: `${request.message}\nLocal screenshot: ${screenshot}` },
      },
      undefined,
      expect.anything(),
    )
  })

  it('discards a staged upload and never posts PNG bytes to another origin', async () => {
    const mcp = client('https://invalid.test/api/attachments/upload/fixture')
    const fetchUpload = vi.fn()
    await expect(launchT3Feedback(mcp, endpoint, request, path(), fetchUpload)).rejects.toThrow(
      'Invalid T3 attachment URL',
    )
    expect(fetchUpload).not.toHaveBeenCalled()
    expect(mcp.callTool).toHaveBeenLastCalledWith(
      {
        name: 't3_attachment_discard',
        arguments: { attachmentId: 'image-id' },
      },
      undefined,
      expect.anything(),
    )
  })
})
