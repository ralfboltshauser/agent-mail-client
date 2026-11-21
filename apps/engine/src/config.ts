import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'

export const Config = z.object({
  listen: z
    .object({
      host: z.string().default('127.0.0.1'),
      port: z.number().int().min(1).max(65535).default(4410),
    })
    .default({ host: '127.0.0.1', port: 4410 }),
  /** Directory holding amc.db. */
  dataDir: z.string(),
  /** Content-addressed store for raw MIME, HTML bodies and attachments. */
  blobDir: z.string(),
  /** Directory holding the Google OAuth client and the encryption key. Readable by the Engine only. */
  secretsDir: z.string(),
  /** Where pre-migration and nightly backups go. */
  backupDir: z.string(),
  /**
   * Tailnet logins allowed to reach the Engine through `tailscale serve`.
   * Requests carrying a different `Tailscale-User-Login` are refused even with a valid token.
   */
  allowedTailscaleLogins: z.array(z.string()).default([]),
  composerOrigin: z
    .url()
    .refine((value) => {
      const url = new URL(value)
      return (
        value === url.origin &&
        (url.protocol === 'https:' ||
          (url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)))
      )
    }, 'Use an HTTPS origin or local HTTP origin with no trailing slash')
    .optional(),
  /** Enable Gmail mailbox notifications from the AMC Pub/Sub subscription in this project. */
  gmailPubSubProject: z
    .string()
    .regex(/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/)
    .optional(),
  features: z.object({ snooze: z.boolean().default(false) }).prefault({}),
  logLevel: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
})
export type Config = z.infer<typeof Config>

export const DEFAULT_CONFIG_PATH = '/etc/amc/config.json'

export function loadConfig(path = process.env.AMC_CONFIG ?? DEFAULT_CONFIG_PATH): Config {
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    throw new Error(`Cannot read the Engine config at ${path}: ${(error as Error).message}`)
  }
  const parsed = Config.safeParse(raw)
  if (!parsed.success) {
    throw new Error(`Invalid Engine config at ${path}:\n${z.prettifyError(parsed.error)}`)
  }
  return parsed.data
}

export function listensOnLoopback(config: Config): boolean {
  return ['127.0.0.1', '::1', 'localhost'].includes(config.listen.host)
}

export function databasePath(config: Config): string {
  return join(config.dataDir, 'amc.db')
}
