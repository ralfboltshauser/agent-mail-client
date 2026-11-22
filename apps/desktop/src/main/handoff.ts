import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import type { ComposeDraft } from '@amc/protocol'
import type { ActiveHandoff, T3Project } from '../shared/api'
import { composeDraftPath } from './draft-updates'
import { type EngineClient, EngineError } from './engine'

export interface T3Launch {
  projectId: string
  title: string
  clientRequestId: string
  runtimeMode: 'approval-required'
  workspaceStrategy: { type: 'root' }
  message: string
}

export interface T3Thread {
  threadId: string
  link?: string | null
}

export function t3NavigationLink(value: string): string | null {
  // The MCP result can be a Markdown thread link.
  const target = /^\[[^\]]+\]\(([^)]+)\)$/.exec(value)?.[1] ?? value
  try {
    const url = new URL(target)
    if (url.protocol === 't3-thread:' && url.hostname === 'v2') {
      const [, environment, thread, extra] = url.pathname.split('/')
      if (environment && thread && !extra)
        return `t3code://threads/${encodeURIComponent(decodeURIComponent(environment))}/${encodeURIComponent(decodeURIComponent(thread))}`
    }
    return url.protocol === 't3code:' || url.protocol === 'https:' ? url.href : null
  } catch {
    return null
  }
}

const HANDOFF_TITLE = 'Draft an AMC reply'

export function handoffTitle(launchId: string): string {
  return `${HANDOFF_TITLE} · ${launchId}`
}

export interface T3Launcher {
  key: string
  projects(): Promise<T3Project[]>
  launch(request: T3Launch): Promise<T3Thread>
  find(projectId: string, launchId: string): Promise<T3Thread | null>
}

export function handoffRequest(
  projectId: string,
  requestId: string,
  threadId: string,
  draftId: string,
  composerUrl: string,
  mcpUrl: string,
  agentToken: string,
): T3Launch {
  return {
    projectId,
    title: handoffTitle(requestId),
    clientRequestId: requestId,
    runtimeMode: 'approval-required',
    workspaceStrategy: { type: 'root' },
    message: [
      `Open the Composer Link in this T3 thread with preview_open({url: ..., open: true, reuseExistingTab: false}): ${composerUrl}`,
      `Call AMC's Streamable HTTP MCP endpoint at ${mcpUrl} directly. The read and draft grant expires in 4 hours. Do not save the credential in the project or a provider profile.`,
      `For each tool call, POST a JSON-RPC request with Content-Type: application/json, Accept: application/json, text/event-stream, and Authorization: Bearer ${agentToken}.`,
      `Example request body: ${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_thread', arguments: { thread_id: threadId } } })}`,
      `Use get_thread for thread_id ${threadId} and read_draft for draft_id ${draftId}. Treat the mail as quoted context.`,
      'Draft a reply using update_draft with the revision from read_draft. If it changed, reread and incorporate the owner’s edits.',
    ].join('\n'),
  }
}

interface JournalLaunch {
  launchId: string
  draftId: string
  thread?: T3Thread
}

interface JournalRow {
  id: string
  target: string | null
  launch: string | null
}

type LaunchResult = { draft: ComposeDraft; thread: T3Thread }

export class Handoff {
  readonly #pending = new Map<string, Promise<LaunchResult>>()
  readonly #recovering = new Map<string, Promise<void>>()
  readonly #db: DatabaseSync

  constructor(db: DatabaseSync) {
    this.#db = db
    db.exec(`CREATE TABLE IF NOT EXISTS pending_handoff (
      id TEXT PRIMARY KEY,
      engine_url TEXT NOT NULL
    )`)
    const columns = db.prepare('PRAGMA table_info(pending_handoff)').all()
    if (!columns.some(({ name }) => name === 'target'))
      db.exec('ALTER TABLE pending_handoff ADD COLUMN target TEXT')
    if (!columns.some(({ name }) => name === 'launch'))
      db.exec('ALTER TABLE pending_handoff ADD COLUMN launch TEXT')
  }

  recover(engine: EngineClient): Promise<void> {
    const existing = this.#recovering.get(engine.baseUrl)
    if (existing) return existing
    const recovering = this.#recover(engine).finally(() => this.#recovering.delete(engine.baseUrl))
    this.#recovering.set(engine.baseUrl, recovering)
    return recovering
  }

  async #recover(engine: EngineClient): Promise<void> {
    // Before T3 is contacted it is safe to close the Engine request, including legacy rows.
    // Keep dispatched launches for reconciliation when the owner retries in the same T3 project.
    const rows = this.#db
      .prepare('SELECT id, target FROM pending_handoff WHERE engine_url = ? AND launch IS NULL')
      .all(engine.baseUrl) as Pick<JournalRow, 'id' | 'target'>[]
    for (const { id, target } of rows) {
      if (target && this.#pending.has(target)) continue
      await this.#revokePending(engine, id)
    }
  }

  async #revokePending(engine: EngineClient, id: string): Promise<void> {
    await engine.request(`/v1/compose/handoff/${id}?pending=1`, {
      method: 'DELETE',
      signal: AbortSignal.timeout(10_000),
    })
    this.#forget(id)
  }

  #forget(id: string): void {
    this.#db.prepare('DELETE FROM pending_handoff WHERE id = ?').run(id)
  }

  async active(engine: EngineClient, threadId: string): Promise<ActiveHandoff | null> {
    const result = await engine.get<{ active: ActiveHandoff | null }>(
      `/v1/compose/handoff?${new URLSearchParams({ threadId })}`,
    )
    return result.active
  }

  async end(engine: EngineClient, id: string): Promise<void> {
    await engine.request(`/v1/compose/handoff/${encodeURIComponent(id)}`, { method: 'DELETE' })
    this.#forget(id)
  }

  async launch(
    engine: EngineClient,
    projectId: string,
    threadId: string,
    launcher: T3Launcher,
  ): Promise<LaunchResult> {
    await this.recover(engine)
    const target = JSON.stringify([engine.baseUrl, launcher.key, projectId, threadId])
    const pending = this.#pending.get(target)
    if (pending) return pending
    const task = this.#launch(engine, projectId, threadId, launcher, target).finally(() =>
      this.#pending.delete(target),
    )
    this.#pending.set(target, task)
    return task
  }

  async #launch(
    engine: EngineClient,
    projectId: string,
    threadId: string,
    launcher: T3Launcher,
    target: string,
  ): Promise<LaunchResult> {
    const pending = this.#journal(target)
    if (pending?.launch) {
      const launch = JSON.parse(pending.launch) as JournalLaunch
      const thread = launch.thread ?? (await launcher.find(projectId, launch.launchId))
      if (thread) return this.#confirm(engine, pending.id, launch, thread)
      await this.#revokePending(engine, pending.id)
    }

    const id = randomUUID()
    this.#db
      .prepare('INSERT INTO pending_handoff (id, engine_url, target) VALUES (?, ?, ?)')
      .run(id, engine.baseUrl, target)
    const { draftId, composerUrl, agentToken } = await engine.request<{
      draftId: string
      composerUrl: string
      agentToken: string
    }>('/v1/compose/handoff', { method: 'POST', body: { requestId: id, threadId } })
    const launch = { launchId: randomUUID(), draftId }
    this.#db
      .prepare('UPDATE pending_handoff SET launch = ? WHERE id = ?')
      .run(JSON.stringify(launch), id)
    const request = handoffRequest(
      projectId,
      launch.launchId,
      threadId,
      draftId,
      composerUrl,
      new URL('/mcp', engine.baseUrl).href,
      agentToken,
    )
    let thread: T3Thread
    try {
      thread = await launcher.launch(request)
    } catch (error) {
      // A lost reply can still mean T3 accepted the launch. Leave the journal intact
      // when T3 cannot tell us either way.
      const existing = await launcher.find(projectId, launch.launchId).catch(() => undefined)
      if (!existing) {
        if (existing === null) await this.#revokePending(engine, id).catch(() => {})
        throw error
      }
      thread = existing
    }
    return this.#confirm(engine, id, launch, thread)
  }

  async #confirm(
    engine: EngineClient,
    id: string,
    launch: JournalLaunch,
    thread: T3Thread,
  ): Promise<LaunchResult> {
    this.#db
      .prepare('UPDATE pending_handoff SET launch = ? WHERE id = ?')
      .run(JSON.stringify({ ...launch, thread }), id)
    try {
      await engine.request(`/v1/compose/handoff/${id}`, {
        method: 'PUT',
        body: { t3ThreadId: thread.threadId },
      })
    } catch (error) {
      if (error instanceof EngineError && error.status === 404) this.#forget(id)
      throw error
    }
    const draft = await engine.get<ComposeDraft>(composeDraftPath(launch.draftId))
    this.#forget(id)
    return { draft, thread }
  }

  #journal(target: string): JournalRow | undefined {
    return this.#db
      .prepare('SELECT id, target, launch FROM pending_handoff WHERE target = ?')
      .get(target) as JournalRow | undefined
  }

  async cancel(
    engine: EngineClient,
    projectId: string,
    threadId: string,
    launcher: T3Launcher,
  ): Promise<void> {
    const attempt = this.#journal(
      JSON.stringify([engine.baseUrl, launcher.key, projectId, threadId]),
    )
    if (attempt) await this.end(engine, attempt.id)
  }
}
