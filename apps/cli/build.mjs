import { chmodSync, readdirSync, readFileSync } from 'node:fs'
import { build } from 'esbuild'

const { version } = JSON.parse(readFileSync(new URL('./package.json', import.meta.url)))
const outfile = 'dist/amc.mjs'
const skillsDir = new URL('./skills/', import.meta.url)
const skills = Object.fromEntries(
  readdirSync(skillsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map(({ name }) => [name, readFileSync(new URL(`${name}/SKILL.md`, skillsDir), 'utf8')]),
)

await build({
  entryPoints: ['src/main.ts'],
  outfile,
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  define: {
    AMC_VERSION: JSON.stringify(version),
    AMC_AGENT_SKILLS: JSON.stringify(skills),
    AMC_TRIAGE_PROMPT: JSON.stringify(
      readFileSync(new URL('./prompts/triage.md', import.meta.url), 'utf8'),
    ),
  },
  banner: {
    js: "#!/usr/bin/env node\nimport { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
  },
})
chmodSync(outfile, 0o755)
