import { relative, sep } from 'node:path'
import { ESLint } from 'eslint'
import baseline from '../eslint-renderer-baseline.json' with { type: 'json' }

const eslint = new ESLint()
const results = await eslint.lintFiles('apps/desktop/src/renderer/**/*.{ts,tsx}')
const remaining = new Map(baseline.map((entry) => [JSON.stringify(entry), entry]))
const failures = []

for (const result of results) {
  if (!result.messages.length) continue
  const file = relative(process.cwd(), result.filePath).split(sep).join('/')
  const lines = result.source?.split(/\r?\n/) ?? []
  const messages = result.messages.filter((diagnostic) => {
    const { ruleId, line, message } = diagnostic
    // The compiler appends an absolute path and line-numbered code frame.
    const summary = message.split('\n\n', 1)[0]
    const source = lines[line - 1]?.trim()
    return !remaining.delete(JSON.stringify({ file, ruleId, source, summary }))
  })

  if (messages.length) {
    failures.push({
      ...result,
      messages,
      errorCount: messages.length,
      warningCount: 0,
    })
  }
}

if (failures.length) {
  const formatter = await eslint.loadFormatter('stylish')
  console.error(await formatter.format(failures))
  process.exitCode = 1
}

for (const { file, ruleId, source } of remaining.values()) {
  console.error(`Remove stale renderer lint baseline entry: ${file} (${ruleId}) — ${source}`)
  process.exitCode = 1
}
