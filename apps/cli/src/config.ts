import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { z } from 'zod'

const CliConfig = z.object({ engineUrl: z.string().url(), token: z.string() })
export type CliConfig = z.infer<typeof CliConfig>

export function configPath(): string {
  const base = process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config')
  return join(base, 'amc', 'cli.json')
}

/** Reads the paired Engine and token; AMC_ENGINE_URL / AMC_TOKEN override the file. */
export function readConfig(): CliConfig | null {
  const fromEnv = { engineUrl: process.env.AMC_ENGINE_URL, token: process.env.AMC_TOKEN }
  let fromFile: Partial<CliConfig> = {}
  try {
    fromFile = JSON.parse(readFileSync(configPath(), 'utf8'))
  } catch {}
  const merged = CliConfig.safeParse({
    engineUrl: fromEnv.engineUrl ?? fromFile.engineUrl,
    token: fromEnv.token ?? fromFile.token,
  })
  return merged.success ? merged.data : null
}

export function writeConfig(config: CliConfig): string {
  const path = configPath()
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 })
  chmodSync(path, 0o600)
  return path
}
