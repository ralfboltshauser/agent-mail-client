import { createElement, Profiler, type ReactNode } from 'react'
import { expect } from 'vitest'

export const commits = new Map<string, number>()

// A callback belongs to one evaluation of the component's return expression.
// Descendant-only updates may call it again without evaluating that component.
export function profile(id: string, children: ReactNode) {
  let recorded = false
  return createElement(
    Profiler,
    {
      id,
      onRender() {
        if (recorded) return
        recorded = true
        commits.set(id, (commits.get(id) ?? 0) + 1)
      },
    },
    children,
  )
}

export function commitCounts() {
  const rows: Record<string, number> = {}
  for (const [id, count] of commits) {
    if (id.startsWith('row:')) rows[id.slice(4)] = count
  }
  return {
    app: commits.get('App') ?? 0,
    workspace: commits.get('MailWorkspace') ?? 0,
    sidebar: commits.get('AppSidebar') ?? 0,
    indicator: commits.get('SyncIndicator') ?? 0,
    list: commits.get('ThreadList') ?? 0,
    reader: commits.get('ThreadView') ?? 0,
    composer: commits.get('Composer') ?? 0,
    recipient: commits.get('RecipientField') ?? 0,
    footer: commits.get('footer') ?? 0,
    rows,
  }
}

export function expectBudget({
  rows,
  ...regions
}: Partial<Omit<ReturnType<typeof commitCounts>, 'rows'>> & {
  rows?: number
}) {
  const measured = commitCounts()
  if (process.env.AMC_RENDERER_COUNTS === '1') console.log(JSON.stringify(measured))
  for (const [region, max] of Object.entries(regions)) {
    expect(measured[region as keyof typeof regions], region).toBeLessThanOrEqual(max)
  }
  if (rows !== undefined) {
    for (const [id, measuredCount] of Object.entries(measured.rows)) {
      expect(measuredCount, id).toBeLessThanOrEqual(rows)
    }
  }
}
