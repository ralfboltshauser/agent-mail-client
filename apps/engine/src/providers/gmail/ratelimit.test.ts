import { describe, expect, it } from 'vitest'
import { QuotaLimiter } from './ratelimit.ts'

describe('QuotaLimiter', () => {
  it('paces to the rate after the initial allowance', async () => {
    const limiter = new QuotaLimiter({ rate: 100, maxRate: 100 })
    const start = Date.now()
    // 100 units are available at once; the remaining 50 take about half a second.
    for (let i = 0; i < 15; i++) await limiter.take(10)
    const elapsed = Date.now() - start
    expect(elapsed).toBeGreaterThanOrEqual(400)
    expect(elapsed).toBeLessThan(1000)
  })

  it('halves on quota errors and recovers slowly', () => {
    const limiter = new QuotaLimiter({ rate: 40, maxRate: 90, minRate: 5 })
    limiter.penalize()
    expect(limiter.rate).toBe(20)
    for (let i = 0; i < 10; i++) limiter.penalize()
    expect(limiter.rate).toBe(5)
    for (let i = 0; i < 2000; i++) limiter.reward()
    expect(limiter.rate).toBe(90)
  })
})
