import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const { version } = JSON.parse(readFileSync(new URL('./package.json', import.meta.url)))

const editor = await build({
  entryPoints: ['src/http/composer-editor.ts'],
  bundle: true,
  minify: true,
  format: 'esm',
  write: false,
})

const wasm = readFileSync(fileURLToPath(import.meta.resolve('@resvg/resvg-wasm/index_bg.wasm')))
const avatarWorker = await build({
  entryPoints: ['src/mail/avatars/decode-worker.ts'],
  bundle: true,
  minify: true,
  platform: 'node',
  target: 'node22',
  format: 'cjs',
  write: false,
  define: {
    AMC_AVATAR_WASM: JSON.stringify(wasm.toString('base64')),
    'import.meta.url': 'undefined',
  },
})

const purgeWorker = await build({
  entryPoints: ['src/mail/triage/purge-worker.ts'],
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'cjs',
  write: false,
})

await build({
  entryPoints: ['src/main.ts'],
  outfile: 'dist/amc-engine.mjs',
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  sourcemap: 'linked',
  define: {
    AMC_VERSION: JSON.stringify(version),
    AMC_AVATAR_WORKER: JSON.stringify(avatarWorker.outputFiles[0].text),
    AMC_PURGE_WORKER: JSON.stringify(purgeWorker.outputFiles[0].text),
    AMC_COMPOSER_SCRIPT: JSON.stringify(editor.outputFiles[0].text),
  },
  // Some dependencies still use require(); give the ESM bundle one.
  banner: {
    js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
  },
})
