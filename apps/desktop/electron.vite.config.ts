import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import babel from '@rolldown/plugin-babel'
import tailwindcss from '@tailwindcss/vite'
import react, { reactCompilerPreset } from '@vitejs/plugin-react'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'

export default defineConfig({
  main: {
    plugins: [
      externalizeDepsPlugin({
        exclude: ['@amc/cli', '@amc/protocol', '@modelcontextprotocol/sdk'],
      }),
    ],
    define: {
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
