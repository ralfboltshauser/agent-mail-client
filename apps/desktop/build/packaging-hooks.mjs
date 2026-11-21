import { execFileSync } from 'node:child_process'
import { join } from 'node:path'

export function beforeBuild() {
  // All app code is bundled by electron-vite. Skip builder's workspace dependency scan.
  return false
}

export function afterPack({ appOutDir, electronPlatformName, packager }) {
  if (electronPlatformName !== 'darwin') return
  const bundle = join(appOutDir, `${packager.appInfo.productFilename}.app`)
  // The bundle contains Electron's standard nested helpers and frameworks.
  // Sign them ad hoc with the app, without looking up a signing identity.
  execFileSync('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', bundle], {
    stdio: 'inherit',
  })
}
