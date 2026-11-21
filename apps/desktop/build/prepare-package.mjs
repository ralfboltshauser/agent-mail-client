import { readFileSync, writeFileSync } from 'node:fs'

if (process.platform !== 'darwin') throw new Error('Mac packaging requires macOS')

const { name, version, type } = JSON.parse(readFileSync('package.json', 'utf8'))
// electron-vite bundles the renderer and main-process code. The package only
// needs the output and Electron's built-in modules, including node:sqlite.
writeFileSync('out/package.json', JSON.stringify({ name, version, type, main: 'main/index.js' }))
