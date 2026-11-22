import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'
import { profileRenderer } from './test/renderer/profile-plugin'

const resolve = {
  alias: { '@': fileURLToPath(new URL('./apps/desktop/src/renderer/src', import.meta.url)) },
}

export default defineConfig({
  test: {
    // node:sqlite still prints an ExperimentalWarning on every process start.
    poolOptions: { forks: { execArgv: ['--disable-warning=ExperimentalWarning'] } },
    projects: [
      {
        resolve,
        test: {
          name: 'unit',
          include: ['apps/*/src/**/*.test.ts', 'packages/*/src/**/*.test.ts'],
        },
      },
      {
        resolve,
        esbuild: { jsx: 'automatic' },
        plugins: [profileRenderer()],
        test: {
          name: 'renderer',
          environment: 'jsdom',
          include: ['test/renderer/**/*.test.tsx'],
        },
      },
    ],
  },
})
