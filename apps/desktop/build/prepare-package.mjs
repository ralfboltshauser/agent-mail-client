import { readFileSync, writeFileSync } from 'node:fs'

if (process.platform !== 'darwin') throw new Error('Mac packaging requires macOS')

const { name, version: devVersion, type } = JSON.parse(readFileSync('package.json', 'utf8'))
const version = process.env.AMC_RELEASE_VERSION ?? devVersion
if (
  process.env.AMC_RELEASE_VERSION !== undefined &&
  !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)
) {
  throw new Error('AMC_RELEASE_VERSION must be a stable version such as 0.1.1')
}
// electron-vite bundles the renderer and main-process code. The package only
// needs the output and Electron's built-in modules, including node:sqlite.
writeFileSync('out/package.json', JSON.stringify({ name, version, type, main: 'main/index.js' }))
