import { describe, expect, it } from 'vitest'
import { doctorWarnings } from './doctor.ts'

describe('doctor warnings', () => {
  const now = Date.UTC(2026, 0, 1)
  const backupAt = now - 36 * 60 * 60 * 1000
  const account = {
    address: 'test@example.com',
    status: 'ready',
    syncLagSeconds: 900,
    lastError: null,
  } as const
  const disk = { path: '/srv/amc', freeBytes: 10, totalBytes: 100 }

  it('accepts exactly 36 hours, 15 minutes and 10 percent free', () => {
    expect(
      doctorWarnings(
        {
          lastBackup: { at: backupAt, bytes: 1024 },
          accounts: [account],
          disks: [disk],
        },
        now,
      ),
    ).toEqual([])
  })

  it('warns beyond each threshold and for failed or expired accounts', () => {
    expect(
      doctorWarnings(
        {
          lastBackup: { at: backupAt - 1, bytes: 1024 },
          accounts: [
            { ...account, syncLagSeconds: 900.001 },
            { ...account, address: 'other@example.com', status: 'error', lastError: 'Sync failed' },
            {
              ...account,
              address: 'new@example.com',
              status: 'new',
              lastError: 'IMAP sync failed',
            },
            {
              ...account,
              address: 'expired@example.com',
              status: 'auth_expired',
              syncLagSeconds: null,
            },
          ],
          disks: [{ ...disk, freeBytes: 9 }],
        },
        now,
      ),
    ).toEqual([
      'Last nightly backup is older than 36 hours.',
      'test@example.com is more than 15 minutes behind on sync.',
      'other@example.com: Sync failed',
      'new@example.com: IMAP sync failed',
      'expired@example.com: auth_expired',
      '/srv/amc has less than 10% disk space free.',
    ])
  })

  it('warns when no backup exists and accepts health data from an older Engine', () => {
    expect(doctorWarnings({ lastBackup: null, disks: [] }, now)).toEqual([
      'No valid nightly backup found.',
    ])
    expect(doctorWarnings({ lastBackup: { at: now, bytes: 0 }, disks: [] }, now)).toEqual([
      'No valid nightly backup found.',
    ])
    expect(doctorWarnings({ disks: [] }, now)).toEqual([])
  })
})
