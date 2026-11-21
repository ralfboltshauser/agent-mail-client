import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: { '@': fileURLToPath(new URL('./apps/desktop/src/renderer/src', import.meta.url)) },
  },
  test: {
    include: ['apps/*/src/**/*.test.ts', 'packages/*/src/**/*.test.ts'],
    // node:sqlite still prints an ExperimentalWarning on every process start.
    poolOptions: { forks: { execArgv: ['--disable-warning=ExperimentalWarning'] } },
  },
})
