import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import babel from '@rolldown/plugin-babel'
import tailwindcss from '@tailwindcss/vite'
import react, { reactCompilerPreset } from '@vitejs/plugin-react'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'

function revision() {
  try {
    return execFileSync('git', ['rev-parse', '--short=12', 'HEAD'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
  } catch {
    return ''
  }
}

export default defineConfig({
  main: {
    plugins: [
      externalizeDepsPlugin({
        exclude: ['@amc/cli', '@amc/protocol', '@modelcontextprotocol/sdk'],
      }),
    ],
    define: {
      AMC_REVISION: JSON.stringify(revision()),
      AMC_TRIAGE_PROMPT: JSON.stringify(
        readFileSync(new URL('../cli/prompts/triage.md', import.meta.url), 'utf8'),
      ),
    },
    build: {
      rollupOptions: {
        input: {
          index: resolve('src/main/index.ts'),
          'triage-worker': resolve('src/main/triage-worker.ts'),
        },
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: { rollupOptions: { output: { format: 'cjs', entryFileNames: '[name].cjs' } } },
  },
  renderer: {
    resolve: { alias: { '@': resolve('src/renderer/src') } },
    plugins: [
      react(),
      babel({ presets: [reactCompilerPreset({ compilationMode: 'annotation' })] }),
      tailwindcss(),
    ],
  },
})
