import type { Health } from './api.ts'

export function doctorWarnings(
  health: Pick<Health, 'lastBackup' | 'accounts' | 'disks'>,
  now = Date.now(),
  detail: 'full' | 'private' = 'full',
): string[] {
  const warnings: string[] = []
  if (health.lastBackup === null || health.lastBackup?.bytes === 0) {
    warnings.push('No valid nightly backup found.')
  } else if (health.lastBackup && now - health.lastBackup.at > 36 * 60 * 60 * 1000) {
    warnings.push('Last nightly backup is older than 36 hours.')
  }
  for (const account of health.accounts ?? []) {
    if (account.syncLagSeconds !== null && account.syncLagSeconds > 15 * 60) {
      warnings.push(
        detail === 'private'
          ? 'An Account is more than 15 minutes behind on sync.'
          : `${account.address} is more than 15 minutes behind on sync.`,
      )
    }
    if (account.lastError || account.status === 'error' || account.status === 'auth_expired') {
      if (detail === 'full')
        warnings.push(`${account.address}: ${account.lastError ?? account.status}`)
      else if (account.status === 'auth_expired') warnings.push('An Account needs sign-in again.')
      else warnings.push('An Account reported a sync error.')
    }
  }
  for (const disk of health.disks) {
    if (disk.freeBytes < disk.totalBytes * 0.1) {
      warnings.push(
        detail === 'private'
          ? 'An Engine disk has less than 10% space free.'
          : `${disk.path} has less than 10% disk space free.`,
      )
    }
  }
  return warnings
}
