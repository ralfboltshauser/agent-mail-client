import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const codesign = '/usr/bin/codesign'
const loginKeychain = join(homedir(), 'Library/Keychains/login.keychain-db')
const identityPattern = /^\s*\d+\)\s+([A-F0-9]{40}) "AMC Local Code Signing"/gm

export function beforeBuild() {
  // All app code is bundled by electron-vite. Skip builder's workspace dependency scan.
  return false
}

export function sign({ app }) {
  // Include self-signed identities that codesign can use without a trust exception.
  const identities = execFileSync(
    '/usr/bin/security',
    ['find-identity', '-p', 'codesigning', loginKeychain],
    { encoding: 'utf8' },
  )
  const hashes = new Set(Array.from(identities.matchAll(identityPattern), ([, hash]) => hash))
  if (hashes.size > 1)
    throw new Error('Multiple AMC Local Code Signing identities in the login keychain.')

  // Seal Electron's nested bundles before signing AMC itself. Only AMC's main
  // executable accesses Safe Storage and needs the persistent identity.
  execFileSync(codesign, ['--force', '--deep', '--sign', '-', app], { stdio: 'inherit' })
  if (hashes.size === 0) {
    console.warn(
      'Warning: signing AMC ad hoc. Run scripts/create-signing-identity.sh to keep Keychain access across updates.',
    )
    return
  }

  const frameworks = join(app, 'Contents/Frameworks')
  const electron = join(frameworks, 'Electron Framework.framework/Versions/Current')
  const libraries = [
    ...readdirSync(frameworks)
      .filter((file) => file.endsWith('.framework'))
      .map((file) => join(frameworks, file)),
    ...readdirSync(join(electron, 'Libraries'))
      .filter((file) => file.endsWith('.dylib'))
      .map((file) => join(electron, 'Libraries', file)),
  ]
  const cdhashes = libraries.map((file) => {
    const result = spawnSync(codesign, ['-d', '--verbose=4', file], { encoding: 'utf8' })
    const hash = /^CDHash=([a-f0-9]{40})$/m.exec(result.stderr)?.[1]
    if (result.status !== 0 || !hash)
      throw new Error(`Cannot read the code directory hash of ${file}`)
    return Buffer.from(hash, 'hex').toString('base64')
  })
  const dir = mkdtempSync(join(tmpdir(), 'amc-sign-'))
  try {
    const constraint = join(dir, 'libraries.plist')
    // A self-signed certificate has no Apple Team ID. Pin the bundled libraries
    // by hash to keep the hardened app from loading substituted code.
    writeFileSync(
      constraint,
      `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict><key>cdhash</key><dict><key>$in</key><array>
${cdhashes.map((hash) => `<data>${hash}</data>`).join('\n')}
</array></dict></dict></plist>`,
    )
    const [identity] = hashes
    execFileSync(
      codesign,
      [
        '--force',
        '--sign',
        identity,
        '--keychain',
        loginKeychain,
        '--timestamp=none',
        '--options',
        'runtime',
        '--entitlements',
        fileURLToPath(new URL('./entitlements.local.plist', import.meta.url)),
        '--library-constraint',
        constraint,
        '--enforce-constraint-validity',
        app,
      ],
      { stdio: 'inherit' },
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}
