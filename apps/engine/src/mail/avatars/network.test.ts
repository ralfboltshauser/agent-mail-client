import { Readable } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import { MAX_INPUT } from './limits.ts'
import { AvatarNetwork, isWebmail, publicDomain, publicIp, readImage } from './network.ts'

const signal = () => new AbortController().signal
const url = new URL('https://sender.dev/favicon.ico')
const png = { kind: 'image', type: 'image/png', bytes: Buffer.from('fixture') } as const

describe('avatar egress policy', () => {
  it('accepts public IPv4 and IPv6 and excludes nonpublic and special-use ranges', () => {
    expect(publicIp('93.184.216.34')).toBe(true)
    expect(publicIp('2606:4700:4700::1111')).toBe(true)
    for (const ip of [
      '127.0.0.1',
      '0.0.0.0',
      '192.168.2.1',
      '172.31.12.10',
      '169.254.169.254',
      '10.10.1.1',
      '100.64.0.1',
      '192.0.2.1',
      '198.18.0.1',
      '224.1.1.1',
      '::1',
      '::ffff:93.184.216.34',
      'fe80::1',
      'fc00::1',
      '2001:db8::1',
      '3fff::1',
    ])
      expect(publicIp(ip), ip).toBe(false)
    for (const name of ['localhost', 'mail.local', 'mail.home.arpa', 'foo.invalid', '127.0.0.1'])
      expect(publicDomain(name), name).toBeNull()
    expect(isWebmail('region.gmail.com')).toBe(true)
    expect(isWebmail('notgmail.com')).toBe(false)
  })

  it('checks every answer, pins a vetted address and vets subsequent hops separately', async () => {
    const addresses =
      vi.fn<NonNullable<ConstructorParameters<typeof AvatarNetwork>[0]>['addresses']>()
    const requestImage =
      vi.fn<NonNullable<ConstructorParameters<typeof AvatarNetwork>[0]>['requestImage']>()
    const network = new AvatarNetwork({ addresses, requestImage, txt: vi.fn() })
    addresses.mockResolvedValueOnce(['93.184.216.34', '127.0.0.1'])
    await expect(network.image(url, 'sender.dev', signal())).rejects.toMatchObject({
      outcome: 'unsafe',
    })
    expect(requestImage).not.toHaveBeenCalled()

    addresses.mockResolvedValueOnce(['93.184.216.34']).mockResolvedValueOnce(['93.184.216.35'])
    requestImage
      .mockResolvedValueOnce({ kind: 'redirect', location: 'https://www.sender.dev/icon' })
      .mockResolvedValueOnce(png)
    await expect(network.image(url, 'sender.dev', signal())).resolves.toEqual(png)
    expect(requestImage.mock.calls.map(([target, ip]) => [target.hostname, ip])).toEqual([
      ['sender.dev', '93.184.216.34'],
      ['www.sender.dev', '93.184.216.35'],
    ])
  })

  it('rejects cross-site, non-HTTPS and private redirects and stops after two hops', async () => {
    const addresses = vi.fn(async () => ['93.184.216.34'])
    const requestImage =
      vi.fn<NonNullable<ConstructorParameters<typeof AvatarNetwork>[0]>['requestImage']>()
    const network = new AvatarNetwork({ addresses, requestImage, txt: vi.fn() })
    for (const location of [
      'https://other.dev/icon',
      'http://sender.dev/icon',
      'https://127.0.0.1/icon',
      'https://sender.dev:444/icon',
      'https://user@sender.dev/icon',
      'https://sender.dev/icon#fragment',
    ]) {
      addresses.mockClear()
      requestImage.mockResolvedValueOnce({ kind: 'redirect', location })
      await expect(network.image(url, 'sender.dev', signal())).rejects.toMatchObject({
        outcome: 'unsafe',
      })
      expect(addresses).toHaveBeenCalledTimes(1)
    }
    requestImage.mockClear()
    requestImage.mockResolvedValue({ kind: 'redirect', location: '/icon' })
    await expect(network.image(url, 'sender.dev', signal())).rejects.toMatchObject({
      outcome: 'unsafe',
    })
    expect(requestImage).toHaveBeenCalledTimes(3)
  })

  it('bounds a stalled DNS answer and never connects after the deadline', async () => {
    vi.useFakeTimers()
    try {
      const controller = new AbortController()
      const requestImage = vi.fn()
      const network = new AvatarNetwork({
        addresses: () => new Promise(() => {}),
        requestImage,
        txt: vi.fn(),
      })
      const checked = expect(
        network.image(url, 'sender.dev', controller.signal),
      ).rejects.toMatchObject({ outcome: 'transient' })
      setTimeout(() => controller.abort(), 4000)
      await vi.advanceTimersByTimeAsync(4000)
      await checked
      expect(requestImage).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('accepts one strict BIMI record and rejects duplicate and non-HTTPS records', async () => {
    const txt = vi.fn<NonNullable<ConstructorParameters<typeof AvatarNetwork>[0]>['txt']>()
    const network = new AvatarNetwork({ addresses: vi.fn(), requestImage: vi.fn(), txt })
    txt.mockResolvedValueOnce([['unrelated'], ['v=BIMI1; l=https://', 'cdn.dev/logo.svg; a=;']])
    await expect(network.bimi('sender.dev', signal())).resolves.toEqual(
      new URL('https://cdn.dev/logo.svg'),
    )
    expect(txt).toHaveBeenCalledWith('default._bimi.sender.dev', expect.any(AbortSignal))
    txt.mockResolvedValueOnce([
      ['v=BIMI1; l=https://cdn.dev/logo.svg'],
      ['v=BIMI1; l=https://cdn.dev/alt.svg'],
    ])
    txt.mockResolvedValueOnce([['v=BIMI1; l=http://cdn.dev/logo.svg;']])
    for (let i = 0; i < 2; i++)
      await expect(network.bimi('sender.dev', signal())).rejects.toMatchObject({
        outcome: 'unsafe',
      })
  })

  it('caps streamed bytes and rejects unsupported types and compressed HTTP bodies', async () => {
    const response = (chunks: Buffer[], headers = {}) =>
      Object.assign(Readable.from(chunks), {
        statusCode: 200,
        headers: { 'content-type': 'image/png', ...headers },
      })
    await expect(
      readImage(response([Buffer.alloc(MAX_INPUT), Buffer.alloc(1)])),
    ).rejects.toMatchObject({ outcome: 'unsafe' })
    await expect(readImage(response([], { 'content-type': 'text/html' }))).rejects.toMatchObject({
      outcome: 'unsafe',
    })
    await expect(readImage(response([], { 'content-encoding': 'gzip' }))).rejects.toMatchObject({
      outcome: 'unsafe',
    })
  })
})
