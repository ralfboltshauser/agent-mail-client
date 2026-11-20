import { describe, expect, it } from 'vitest'
import { QuotaLimiter } from './ratelimit.ts'

describe('QuotaLimiter', () => {
  it('lets a burst through, then paces to the rate', async () => {
    const limiter = new QuotaLimiter(1000, 10)
    const start = Date.now()
    for (let i = 0; i < 2; i++) await limiter.take(5) // the burst
    for (let i = 0; i < 10; i++) await limiter.take(5) // 50 units at 1000/s ≈ 50 ms
    const elapsed = Date.now() - start
    expect(elapsed).toBeGreaterThanOrEqual(40)
    expect(elapsed).toBeLessThan(500)
  })
})
