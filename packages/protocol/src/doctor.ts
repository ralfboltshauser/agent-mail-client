import type { Health } from './api.ts'

export function doctorWarnings(
  health: Pick<Health, 'lastBackup' | 'accounts' | 'disks'>,
  now = Date.now(),
): string[] {
  const warnings: string[] = []
  if (health.lastBackup === null || health.lastBackup?.bytes === 0) {
    warnings.push('No valid nightly backup found.')
  } else if (health.lastBackup && now - health.lastBackup.at > 36 * 60 * 60 * 1000) {
    warnings.push('Last nightly backup is older than 36 hours.')
  }
  for (const account of health.accounts ?? []) {
    if (account.syncLagSeconds !== null && account.syncLagSeconds > 15 * 60) {
      warnings.push(`${account.address} is more than 15 minutes behind on sync.`)
    }
    if (account.lastError || account.status === 'error' || account.status === 'auth_expired') {
      warnings.push(`${account.address}: ${account.lastError ?? account.status}`)
    }
  }
  for (const disk of health.disks) {
    if (disk.freeBytes < disk.totalBytes * 0.1) {
      warnings.push(`${disk.path} has less than 10% disk space free.`)
    }
  }
  return warnings
}
