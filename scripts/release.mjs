import { spawnSync } from 'node:child_process'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'

const home = homedir()
const configPath = join(process.env.XDG_CONFIG_HOME || join(home, '.config'), 'amc/release.json')
const artifactRoot = join(process.env.XDG_STATE_HOME || join(home, '.local/state'), 'amc/releases')
const bundle = join(home, 'Applications/AMC.app')
const versionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/
const commandArgs = process.argv.slice(2)

function start(command, args, options = {}) {
  return spawnSync(command, args, { encoding: 'utf8', ...options })
}

function run(command, args, options = {}) {
  const { label = command, ...spawnOptions } = options
  const result = start(command, args, spawnOptions)
  if (result.status !== 0) throw new Error(`${label} failed`)
  return result.stdout?.trim() ?? ''
}

const git = (args, options) => run('git', args, options)

function compareVersions(left, right) {
  const a = left.split('.').map(BigInt)
  const b = right.split('.').map(BigInt)
  for (let i = 0; i < 3; i += 1) {
    if (a[i] > b[i]) return 1
    if (a[i] < b[i]) return -1
  }
  return 0
}

function readConfig() {
  if (!existsSync(configPath)) throw new Error('Create the private AMC release configuration first')
  let config
  try {
    config = JSON.parse(readFileSync(configPath, 'utf8'))
  } catch {
    throw new Error('The private AMC release configuration is invalid JSON')
  }
  if (
    !config ||
    !/^(?:[a-zA-Z0-9_][\w.-]*@)?[a-zA-Z0-9][\w.-]*$/.test(config.ubuntuSshTarget ?? '')
  ) {
    throw new Error('Configure ubuntuSshTarget as an SSH alias or user@host')
  }
  const retired = config.retiredDetachedWorktrees ?? []
  if (
    !Array.isArray(retired) ||
    retired.some((path) => typeof path !== 'string' || !isAbsolute(path))
  ) {
    throw new Error('retiredDetachedWorktrees must contain absolute checkout paths')
  }
  return { target: config.ubuntuSshTarget, retired }
}

function githubRepository(remote) {
  const match =
    /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([\w.-]+\/[\w.-]+?)(?:\.git)?$/.exec(
      remote,
    )
  if (!match) throw new Error('Set origin to a GitHub repository before releasing')
  return match[1]
}

function planRelease() {
  const repo = githubRepository(git(['remote', 'get-url', 'origin']))
  const pushRepo = githubRepository(git(['remote', 'get-url', '--push', '--all', 'origin']))
  if (pushRepo.toLowerCase() !== repo.toLowerCase()) {
    throw new Error('Origin must fetch and push to the same GitHub repository')
  }
  const info = JSON.parse(
    run('gh', ['repo', 'view', repo, '--json', 'defaultBranchRef,viewerPermission']),
  )
  if (!['ADMIN', 'MAINTAIN', 'WRITE'].includes(info.viewerPermission) || !info.defaultBranchRef) {
    throw new Error('GitHub authentication must have write access to origin')
  }

  git(['fetch', '--prune', '--no-prune-tags', '--no-tags', 'origin'])
  const ref = `refs/remotes/origin/${info.defaultBranchRef.name}`
  const defaultBranch = `refs/heads/${info.defaultBranchRef.name}`
  const remoteRefs = git(['ls-remote', 'origin', defaultBranch, 'refs/tags/v*'])
  if (
    !remoteRefs
      .split('\n')
      .includes(`${start('git', ['rev-parse', '--verify', ref]).stdout?.trim()}\t${defaultBranch}`)
  ) {
    git(['fetch', '--no-tags', 'origin', `+${defaultBranch}:${ref}`])
  }
  const head = git(['rev-parse', '--verify', `${ref}^{commit}`])
  if (!remoteRefs.split('\n').includes(`${head}\t${defaultBranch}`)) {
    throw new Error('The fetched default branch does not match GitHub. Refresh and retry.')
  }
  const tags = new Map()
  for (const line of remoteRefs.split('\n')) {
    const [sha, refName] = line.split('\t')
    const tag = /^refs\/tags\/v(.+?)(\^\{\})?$/.exec(refName ?? '')
    if (!tag || !versionPattern.test(tag[1])) continue
    if (tag[2] || !tags.has(tag[1])) tags.set(tag[1], sha)
  }
  const versions = [...tags.keys()].sort(compareVersions)
  const latest = versions.at(-1)
  if (latest) {
    const tag = `v${latest}`
    const sha = tags.get(latest)
    git(['merge-base', '--is-ancestor', sha, head], { label: 'Latest release tag ancestry check' })
    const release = start('gh', ['api', `repos/${repo}/releases/tags/${tag}`, '--jq', '.html_url'])
    if (release.status !== 0) {
      if (!/\(HTTP 404\)/.test(release.stderr ?? ''))
        throw new Error('Could not check the latest GitHub release')
      return { repo, sha, head, version: latest, tag, resume: true, previous: versions.at(-2) }
    }
    if (sha === head) {
      return { sha: head, head, tag, url: release.stdout.trim() }
    }
  }
  const { version: baseline } = JSON.parse(git(['show', `${head}:apps/desktop/package.json`]))
  if (!versionPattern.test(baseline))
    throw new Error('Desktop manifest version is not a stable version')
  const sourceVersion = latest && compareVersions(latest, baseline) > 0 ? latest : baseline
  const [major, minor, patch] = sourceVersion.split('.')
  const version = `${major}.${minor}.${BigInt(patch) + 1n}`
  return { repo, sha: head, head, version, tag: `v${version}`, previous: latest }
}

function worktreeRecords() {
  return git(['worktree', 'list', '--porcelain', '-z'])
    .split('\0\0')
    .map((record) => record.split('\0'))
}

function retiredAndClean(path, head) {
  const [, ...linked] = worktreeRecords()
  const record = linked.find(([entry]) => entry === `worktree ${path}`)
  if (
    !record?.includes('detached') ||
    record.some((field) => /^(locked|prunable)( |$)/.test(field))
  ) {
    return false
  }
  const status = start('git', [
    '-C',
    path,
    'status',
    '--porcelain',
    '--untracked-files=all',
    '--ignored',
  ])
  if (status.status !== 0 || status.stdout !== '') return false
  if (start('git', ['-C', path, 'merge-base', '--is-ancestor', 'HEAD', head]).status !== 0)
    return false
  const openFiles = start('lsof', ['-t', '+D', path])
  return openFiles.status === 1 && openFiles.stdout === '' && openFiles.stderr === ''
}

function retireWorktree(path, head) {
  // Editors and tasks reopen the original path. A private sibling keeps the
  // move on the same filesystem and lets us recheck the isolated checkout.
  const quarantine = mkdtempSync(join(dirname(path), '.amc-retired-'))
  const isolated = join(quarantine, 'checkout')
  let removed = false
  try {
    git(['worktree', 'move', '--', path, isolated], { label: 'Isolate retired worktree' })
    if (retiredAndClean(isolated, head)) {
      git(['worktree', 'remove', '--', isolated], { label: 'Retired worktree removal' })
      removed = true
    }
  } catch (error) {
    console.warn(error.message)
  }
  if (existsSync(isolated)) {
    const restored = start('git', ['worktree', 'move', '--', isolated, path])
    if (restored.status !== 0) throw new Error(`Retired checkout was preserved at ${isolated}`)
  }
  // Avoid recursive cleanup of any directory that contained an existing checkout.
  run('rmdir', [quarantine], { label: 'Retirement staging cleanup' })
  return removed
}

function cleanWorktrees(retired, head, dry) {
  const current = realpathSync(git(['rev-parse', '--show-toplevel']))
  for (const path of new Set(retired)) {
    if (!existsSync(path)) continue
    const absolute = realpathSync(path)
    if (absolute === current || !retiredAndClean(absolute, head)) {
      console.log(`Preserved configured worktree ${path}`)
    } else if (dry) {
      console.log(`Would remove retired worktree ${path}`)
    } else if (retireWorktree(absolute, head)) {
      console.log(`Removed retired worktree ${path}`)
    } else {
      console.log(`Preserved configured worktree ${path}`)
    }
  }
}

function checkHost(target, command) {
  return run('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', target, command], {
    label: 'Ubuntu deployment check',
  })
}

function requireHostRelease(target, plan) {
  const receipt = checkHost(
    target,
    'set -e; systemctl is-active --quiet amc-engine.service; systemctl is-active --quiet amc-backup.timer; ' +
      'curl -fsS --max-time 2 -o /dev/null http://127.0.0.1:4410/health; ' +
      'cd /opt/amc/current; running=$(systemctl show --property=InvocationID --value amc-engine.service); ' +
      'test -n "$running"; test "$running" = "$(cat INVOCATION)"; cat RELEASE VERSION',
  )
  if (receipt !== `${plan.sha}\n${plan.version}`) {
    throw new Error('The active Ubuntu release does not match the selected release')
  }
}

function appVersion(path) {
  return run('/usr/libexec/PlistBuddy', [
    '-c',
    'Print :CFBundleShortVersionString',
    join(path, 'Contents/Info.plist'),
  ])
}

function appRunning() {
  const processPaths = run('ps', ['-ax', '-o', 'comm=']).split('\n')
  return processPaths.some((path) => path.trim() === join(bundle, 'Contents/MacOS/AMC'))
}

function waitForApp(running) {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    if (appRunning() === running) return
    run('sleep', ['1'])
  }
  throw new Error(
    running ? 'The installed Mac app did not start' : 'The installed Mac app did not quit',
  )
}

function installMac(tree, staged, version) {
  const archive = 'Contents/Resources/app.asar'
  const sameBuild =
    existsSync(bundle) &&
    appVersion(bundle) === version &&
    start('cmp', ['-s', join(bundle, archive), join(staged, archive)]).status === 0
  if (!sameBuild) {
    if (appRunning()) {
      run(
        'osascript',
        [
          '-e',
          'on run argv',
          '-e',
          'tell application (POSIX file (item 1 of argv)) to quit',
          '-e',
          'end run',
          bundle,
        ],
        { label: 'Graceful AMC quit' },
      )
      waitForApp(false)
    }
    run('bash', ['scripts/install-desktop.sh', '--from-package'], { cwd: tree, stdio: 'inherit' })
    if (appVersion(bundle) !== appVersion(staged))
      throw new Error('Installed Mac version differs from the staged app')
  }
  run('cmp', ['-s', join(bundle, archive), join(staged, archive)], {
    label: 'Installed Mac payload verification',
  })
  run('/usr/bin/codesign', ['--verify', '--deep', '--strict', bundle], {
    label: 'Installed Mac code signature',
  })
  if (!appRunning()) {
    run('open', ['-a', bundle], { label: 'Launch installed AMC' })
    waitForApp(true)
  }
  run('bash', ['scripts/install-cli.sh'], {
    cwd: tree,
    stdio: 'inherit',
    label: 'Mac AMC CLI install',
  })
}

function release(plan, target) {
  const treeDir = mkdtempSync(join(tmpdir(), 'amc-release-'))
  const tree = join(treeDir, 'source')
  const env = { ...process.env, AMC_RELEASE_VERSION: plan.version }
  const inTree = { cwd: tree, env, stdio: 'inherit' }
  let added = false
  try {
    git(['worktree', 'add', '--detach', tree, plan.sha])
    added = true
    run('pnpm', ['verify'], inTree)
    run('pnpm', ['--filter', '@amc/desktop', 'package'], inTree)
    const dist = join(tree, 'apps/desktop/dist')
    const staged = join(dist, 'mac-arm64/AMC.app')
    const signature = start('/usr/bin/codesign', ['-dv', '--verbose=4', staged])
    if (
      signature.status !== 0 ||
      !/^Authority=AMC Local Code Signing$/m.test(signature.stderr ?? '')
    ) {
      throw new Error('The new app needs the AMC Local Code Signing identity')
    }
    run('/usr/bin/codesign', ['--verify', '--deep', '--strict', staged], {
      label: 'Staged Mac code signature',
    })
    if (appVersion(staged) !== plan.version)
      throw new Error('The staged app version differs from the release version')
    const dmgName = `AMC-${plan.version}-arm64.dmg`
    const dmg = join(dist, dmgName)
    run('hdiutil', ['verify', dmg], { label: 'Mac disk image verification' })

    if (!plan.resume) {
      const tagRef = `refs/tags/${plan.tag}`
      // Push the verified checkout HEAD directly so a failed push leaves no local tag to repair.
      git(['-c', 'core.hooksPath=.githooks', 'push', 'origin', `HEAD:${tagRef}`], inTree)
    }
    console.log(
      `Release checkpoint ${plan.tag} at ${plan.sha}. Rerun to resume if any rollout step fails.`,
    )
    const host = start('bash', ['scripts/deploy-host.sh', target], { cwd: tree, env })
    if (host.status === 70)
      throw new Error(
        'Ubuntu rollout failed and the prior Engine did not recover. Follow the rollback runbook.',
      )
    if (host.status === 75) throw new Error('Another deployment holds the Ubuntu release lock')
    if (host.status === 76)
      throw new Error('Ubuntu Engine is active but the SSH user CLI skill refresh failed')
    if (host.status !== 0)
      throw new Error('Ubuntu rollout failed. Check the Host locally before retrying.')
    requireHostRelease(target, plan)
    console.log('Ubuntu Engine, backup timer, and SSH user CLI are ready.')
    installMac(tree, staged, plan.version)

    const dir = join(artifactRoot, plan.tag)
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    const temporary = join(dir, `.${dmgName}.${process.pid}`)
    copyFileSync(dmg, temporary)
    renameSync(temporary, join(dir, dmgName))
    requireHostRelease(target, plan)
    if (!appRunning()) throw new Error('The installed Mac app exited during release verification')
    const notesStart = plan.previous ? ['--notes-start-tag', `v${plan.previous}`] : []
    const url = run(
      'gh',
      [
        'release',
        'create',
        plan.tag,
        '-R',
        plan.repo,
        '--verify-tag',
        '--generate-notes',
        ...notesStart,
      ],
      {
        label: 'GitHub release publication',
      },
    )
    console.log(
      `Released ${plan.tag} at ${plan.sha}\nMac disk image: ${join(dir, dmgName)}\n${url}`,
    )
  } finally {
    if (added) {
      git(['worktree', 'remove', '--force', '--', tree], {
        label: 'Release scratch worktree cleanup',
      })
    }
    rmSync(treeDir, { recursive: true })
  }
}

function main() {
  const dry = commandArgs[0] === '--dry-run'
  if (commandArgs.length > (dry ? 1 : 0)) throw new Error('Usage: pnpm release [--dry-run]')
  if (process.platform !== 'darwin' || process.arch !== 'arm64') {
    throw new Error('Run the AMC release from an Apple silicon Mac')
  }
  process.chdir(git(['rev-parse', '--show-toplevel']))
  const { target, retired } = readConfig()
  const releaseOrPlan = () => {
    const plan = planRelease()
    if (plan.url) {
      console.log(`${plan.tag} already released at ${plan.sha}\n${plan.url}`)
    } else {
      console.log(`${plan.resume ? 'Resume' : 'Plan'} ${plan.tag} from ${plan.sha}`)
      if (existsSync(bundle) && compareVersions(appVersion(bundle), plan.version) > 0) {
        throw new Error('The installed Mac app is newer than the selected release')
      }
      const hostVersion = checkHost(
        target,
        'set -e; test -d /opt/amc/releases; sudo -n true; if test -f /opt/amc/current/VERSION; then cat /opt/amc/current/VERSION; fi',
      )
      if (
        hostVersion &&
        (!versionPattern.test(hostVersion) || compareVersions(hostVersion, plan.version) > 0)
      ) {
        throw new Error('The Ubuntu release version is newer or invalid')
      }
      if (!dry) release(plan, target)
    }
    cleanWorktrees(retired, plan.head, dry)
  }
  if (dry) return releaseOrPlan()

  const lock = resolve(git(['rev-parse', '--git-common-dir']), 'amc-release.lock')
  try {
    mkdirSync(lock, { mode: 0o700 })
  } catch (error) {
    if (error.code === 'EEXIST') throw new Error('Another AMC release owns the Git release lock')
    throw error
  }
  try {
    writeFileSync(join(lock, 'pid'), `${process.pid}\n`, { mode: 0o600 })
    releaseOrPlan()
  } finally {
    rmSync(lock, { recursive: true })
  }
}

try {
  main()
} catch (error) {
  console.error(error.message)
  process.exitCode = 1
}
