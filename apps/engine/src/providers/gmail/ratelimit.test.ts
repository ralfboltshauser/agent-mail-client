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
