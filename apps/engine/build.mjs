import { readFileSync } from 'node:fs'
import { build } from 'esbuild'

const { version } = JSON.parse(readFileSync(new URL('./package.json', import.meta.url)))

const editor = await build({
  entryPoints: ['src/http/composer-editor.ts'],
  bundle: true,
  minify: true,
  format: 'esm',
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
    AMC_COMPOSER_SCRIPT: JSON.stringify(editor.outputFiles[0].text),
  },
  // Some dependencies still use require(); give the ESM bundle one.
  banner: {
    js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
  },
})
