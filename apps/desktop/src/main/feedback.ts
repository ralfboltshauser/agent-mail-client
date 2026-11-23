import { randomUUID } from 'node:crypto'
import { chmodSync, lstatSync, mkdirSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { type FeedbackDraft, feedbackView } from '../shared/feedback'
import type { T3Launcher } from './handoff'

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
    .filter(
      (entry) =>
        entry.isFile() && /^\d+-[0-9a-f-]{36}\.png$/.test(entry.name) && entry.name !== name,
    )
    .map((entry) => entry.name)
    .sort((a, b) => Number.parseInt(b, 10) - Number.parseInt(a, 10))
  for (const expired of older.slice(19)) unlinkSync(join(directory, expired))
  return path
}

export interface FeedbackContext {
  version: string
  view: unknown
  width: number
  height: number
  at: Date
}

export function feedbackMessage(draft: FeedbackDraft, context: FeedbackContext, path?: string) {
  const text = draft.text.trim()
  const markdown = draft.markdown.trim()
  return [
    'AMC feedback — use the amc-feedback skill (.agents/skills/amc-feedback/SKILL.md).',
    ...(text ? [text] : []),
    ...(markdown ? [markdown] : []),
    ...(!text && !markdown ? ['Wait for the owner to add details.'] : []),
    `Context: AMC ${context.version}, view ${feedbackView(context.view)}, window ${context.width}×${context.height}, ${context.at.toISOString()}`,
    ...(path ? [`Local screenshot: ${path}`] : []),
  ].join('\n\n')
}

export function launchFeedback(
  launcher: T3Launcher,
  projectId: string,
  id: string,
  draft: FeedbackDraft,
  context: FeedbackContext,
  path: string,
) {
  return launcher.launch(
    {
      projectId,
      title: 'AMC feedback',
      clientRequestId: id,
      runtimeMode: 'approval-required',
      workspaceStrategy: { type: 'root' },
      message: feedbackMessage(draft, context),
    },
    path,
  )
}
