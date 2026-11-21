import { describe, expect, it, vi } from 'vitest'
import { QUOTA_COST, QuotaLimiter } from './ratelimit.ts'

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

  it('grants a batch at a backed-off rate and unblocks the following caller', async () => {
    vi.useFakeTimers()
    try {
      const limiter = new QuotaLimiter()
      limiter.penalize()
      await vi.advanceTimersByTimeAsync(5000)
      limiter.penalize()
      expect(limiter.rate).toBe(20)
      const order: string[] = []
      void limiter.take(QUOTA_COST.batchModify, true).then(() => order.push('batch'))
      void limiter.take(1).then(() => order.push('next'))
      await vi.advanceTimersByTimeAsync(3000)
      expect(order).toEqual(['batch', 'next'])
    } finally {
      vi.useRealTimers()
    }
  })

  it('halves on quota errors and recovers slowly', () => {
    const limiter = new QuotaLimiter({ rate: 40, maxRate: 90, minRate: 5 })
    limiter.penalize()
    limiter.penalize() // same burst: ignored
    expect(limiter.rate).toBe(20)
    for (let i = 0; i < 20; i++) limiter.reward()
    expect(limiter.rate).toBe(30)
    for (let i = 0; i < 1000; i++) limiter.reward()
    expect(limiter.rate).toBe(90)
  })
})

describe('QuotaLimiter priorities', () => {
  it('serves urgent calls before queued background calls', async () => {
    const limiter = new QuotaLimiter({ rate: 100, maxRate: 100 })
    await limiter.take(200) // drain the bucket
    const order: string[] = []
    const background = Promise.all(
      [1, 2, 3].map((i) => limiter.take(20).then(() => order.push(`bg${i}`))),
    )
    await limiter.take(20, true).then(() => order.push('urgent'))
    await background
    expect(order[0]).toBe('urgent')
  })
})
