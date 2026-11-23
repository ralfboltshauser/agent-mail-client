import { randomUUID } from 'node:crypto'
import { chmodSync, lstatSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { readRecentLogs } from '@amc/observability/local-reader'
import { type FeedbackDraft, feedbackView } from '../shared/feedback'
import type { T3Launcher } from './handoff'

export const feedbackCaptureLifetimeMs = 24 * 60 * 60 * 1000
const captureName = /^\d+-[0-9a-f-]{36}\.png$/
const excerptPath = (path: string) => `${path.slice(0, -4)}.logs.json`

export const feedbackProject = 'mcp:9b67c013-f662-47d0-93c1-1c87a28ae685'

export function saveFeedbackCapture(userData: string, png: Buffer, at: Date) {
  const directory = join(userData, 'feedback')
  mkdirSync(directory, { mode: 0o700, recursive: true })
  if (!lstatSync(directory).isDirectory()) throw new Error('Invalid feedback directory.')
  chmodSync(directory, 0o700)
  const name = `${at.getTime()}-${randomUUID()}.png`
  const path = join(directory, name)
  writeFileSync(path, png, { mode: 0o600, flag: 'wx' })
  chmodSync(path, 0o600)

  const older = readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && captureName.test(entry.name) && entry.name !== name)
    .map((entry) => entry.name)
    .sort((a, b) => Number.parseInt(b, 10) - Number.parseInt(a, 10))
  for (const [index, old] of older.entries()) {
    if (index >= 19 || at.getTime() - Number.parseInt(old, 10) >= feedbackCaptureLifetimeMs)
      removeFeedbackCapture(join(directory, old))
  }
  // An interrupted removal can leave an excerpt behind without a screenshot.
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.logs.json')) continue
    const pngName = entry.name.replace(/\.logs\.json$/, '.png')
    if (!captureName.test(pngName)) continue
    try {
      if (lstatSync(join(directory, pngName)).isFile()) continue
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    rmSync(join(directory, entry.name), { force: true })
  }
  return path
}

export function removeFeedbackCapture(path: string) {
  if (!captureName.test(basename(path))) return
  rmSync(excerptPath(path), { force: true })
  rmSync(path, { force: true })
}

export async function saveFeedbackExcerpt(path: string, directory: string, at: Date) {
  if (!captureName.test(basename(path))) throw new Error('Invalid feedback capture path')
  const recent = await readRecentLogs(directory, at.getTime())
  const excerpt = excerptPath(path)
  writeFileSync(excerpt, `${JSON.stringify(recent)}\n`, { mode: 0o600, flag: 'wx' })
  return excerpt
}

export interface FeedbackContext {
  version: string
  view: unknown
  width: number
  height: number
  at: Date
}

export function feedbackMessage(
  draft: FeedbackDraft,
  context: FeedbackContext,
  path?: string,
  excerpt?: string,
) {
  const text = draft.text.trim()
  const markdown = draft.markdown.trim()
  return [
    'AMC feedback — use the amc-feedback skill (.agents/skills/amc-feedback/SKILL.md).',
    ...(text ? [text] : []),
    ...(markdown ? [markdown] : []),
    ...(!text && !markdown ? ['Wait for the owner to add details.'] : []),
    `Context: AMC ${context.version}, view ${feedbackView(context.view)}, window ${context.width}×${context.height}, ${context.at.toISOString()}`,
    ...(path ? [`Local screenshot: ${path}`] : []),
    ...(excerpt ? [`Local log excerpt: ${excerpt}`] : []),
  ].join('\n\n')
}

export function launchFeedback(
  launcher: T3Launcher,
  projectId: string,
  id: string,
  draft: FeedbackDraft,
  context: FeedbackContext,
  path: string,
  excerpt?: string,
) {
  return launcher.launch(
    {
      projectId,
      title: 'AMC feedback',
      clientRequestId: id,
      workspaceStrategy: { type: 'root' },
      message: feedbackMessage(draft, context, undefined, excerpt),
    },
    path,
  )
}
