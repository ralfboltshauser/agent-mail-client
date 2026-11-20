import { hostname } from 'node:os'
import type { Health, Me, PairResponse } from '@amc/protocol'
import { Command } from 'commander'
import { authed, EngineError, request } from './client.ts'
import { readConfig, writeConfig } from './config.ts'

declare const AMC_VERSION: string | undefined
const VERSION = typeof AMC_VERSION === 'string' ? AMC_VERSION : 'dev'

const program = new Command()
  .name('amc')
  .description('Agent Mail Client: work with your mail from the shell')
  .version(VERSION)

program
  .command('pair')
  .description('Pair this machine with an Engine using a code from `amc-engine pair` on the Host')
  .argument('<code>', 'the one-time pairing code')
  .requiredOption('--engine <url>', 'the Engine URL, e.g. https://host.tailnet.ts.net:4443')
  .option('--name <name>', 'a name for this device', hostname())
  .action(async (code: string, opts: { engine: string; name: string }) => {
    const res = await request<PairResponse>(opts.engine, '/v1/auth/pair', {
      method: 'POST',
      body: { code, deviceName: opts.name },
    })
    const path = writeConfig({ engineUrl: opts.engine, token: res.token })
    console.log(`Paired as "${opts.name}" with scopes: ${res.scopes.join(', ')}`)
    console.log(`Saved to ${path}`)
  })

program
  .command('status')
  .description('Show the Engine version, storage and who this token is')
  .option('--json', 'print JSON')
  .action(async (opts: { json?: boolean }) => {
    const api = authed(requireConfig())
    const [me, health] = await Promise.all([api<Me>('/v1/me'), api<Health>('/v1/health')])
    if (opts.json) {
      console.log(JSON.stringify({ me, health }, null, 2))
      return
    }
    console.log(
      `Engine ${health.version} · schema v${health.schemaVersion} · up ${formatDuration(health.uptimeSeconds)}`,
    )
    console.log(`Token  ${me.name} (${me.kind}) · ${me.scopes.join(', ')}`)
    console.log(`Database ${formatBytes(health.database.bytes)}`)
    for (const disk of health.disks) {
      console.log(
        `Disk   ${disk.path}: ${formatBytes(disk.freeBytes)} free of ${formatBytes(disk.totalBytes)}`,
      )
    }
  })

function requireConfig() {
  const config = readConfig()
  if (!config) {
    console.error(
      'Not paired. Run `amc-engine pair` on the Host, then `amc pair <code> --engine <url>`.',
    )
    process.exit(1)
  }
  return config
}

export function formatBytes(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit++
  }
  return `${value.toFixed(value < 10 && unit > 0 ? 1 : 0)} ${units[unit]}`
}

function formatDuration(seconds: number): string {
  if (seconds < 120) return `${seconds}s`
  if (seconds < 7200) return `${Math.round(seconds / 60)}m`
  if (seconds < 172800) return `${Math.round(seconds / 3600)}h`
  return `${Math.round(seconds / 86400)}d`
}

program.parseAsync().catch((error: unknown) => {
  if (error instanceof EngineError) console.error(`Error: ${error.message}`)
  else console.error(error)
  process.exit(1)
})
