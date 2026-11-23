import { act, cleanup, render } from '@testing-library/react'
import { Profiler } from 'react'
import { expect, it, vi } from 'vitest'
import { SenderAvatarCache } from '../../apps/desktop/src/renderer/src/features/sender-avatar/cache'
import { avatarInitials } from '../../apps/desktop/src/renderer/src/features/sender-avatar/initials'
import { SenderAvatar } from '../../apps/desktop/src/renderer/src/features/sender-avatar/sender-avatar'
import type { DesktopSenderAvatarResults, SmartInboxApi } from '../../apps/desktop/src/shared/api'
import { deferred } from './adapter'

const image = 'data:image/png;base64,c3ludGhldGlj'
const row = (messageId: string, digest: string | null) => ({
  accountId: 'a',
  messageId,
  initials: 'AB',
  color: '#304879',
  source: digest ? ('favicon' as const) : ('initials' as const),
  digest,
})

it('assigns initials colors by normalized email, with a name fallback', () => {
  const ada = avatarInitials('ada@fixture.dev', 'Ada Baker')
  expect(avatarInitials('  ADA@FIXTURE.DEV ', 'Ada Jones').color).toBe(ada.color)
  expect(avatarInitials('casey@fixture.dev', 'Ada Baker').color).not.toBe(ada.color)
  expect(avatarInitials(null, ' Ada Baker ').color).toBe(
    avatarInitials(undefined, 'ADA BAKER').color,
  )
})

it('batches mounted avatars and commits only consumers of the changed image', async () => {
  vi.useFakeTimers()
  try {
    const first = deferred<DesktopSenderAvatarResults>()
    let currentDigest = '1'
    let currentImage: string | undefined
    let offline = false
    const resolve = vi
      .fn<SmartInboxApi['resolveSenderAvatars']>()
      .mockReturnValueOnce(first.promise)
      .mockImplementation(async ({ messages }) => {
        if (offline) throw new Error('Fixture offline')
        return {
          rows: messages.map(({ messageId }) =>
            messageId === 'changed'
              ? { ...row('changed', currentDigest), image: currentImage }
              : row(messageId, null),
          ),
        }
      })
    const cache = new SenderAvatarCache(resolve)
    const changed = vi.fn()
    const unchanged = vi.fn()
    const { getByTestId, unmount } = render(
      <>
        <Profiler id={'changed'} onRender={changed}>
          <SenderAvatar
            cache={cache}
            accountId="a"
            messageId="changed"
            name="Ada Baker"
            data-testid="avatar"
          />
        </Profiler>
        <Profiler id={'unchanged'} onRender={unchanged}>
          <SenderAvatar
            cache={cache}
            accountId="a"
            messageId="unchanged"
            address="casey-doe@fixture.dev"
          />
        </Profiler>
      </>,
    )
    const avatar = getByTestId('avatar')
    expect(avatar.textContent).toBe('AB')
    expect(avatar.style.width).toBe('32px')
    changed.mockClear()
    unchanged.mockClear()
    await act(async () => vi.advanceTimersByTimeAsync(16))
    expect(resolve).toHaveBeenCalledExactlyOnceWith(
      {
        messages: [
          { accountId: 'a', messageId: 'changed' },
          { accountId: 'a', messageId: 'unchanged' },
        ],
      },
      [],
    )

    await act(async () =>
      first.resolve({
        rows: [{ ...row('changed', '1'), image }, row('unchanged', null)],
      }),
    )
    expect(avatar.querySelector('img')?.getAttribute('src')).toBe(image)
    expect(getByTestId('avatar')).toBe(avatar)
    expect(changed).toHaveBeenCalledTimes(1)
    expect(unchanged).not.toHaveBeenCalled()
    changed.mockClear()
    await act(async () => vi.advanceTimersByTimeAsync(60_000))
    expect(avatar.querySelector('img')?.getAttribute('src')).toBe(image)
    expect(changed).not.toHaveBeenCalled()
    expect(unchanged).not.toHaveBeenCalled()

    currentDigest = '2'
    currentImage = 'data:image/png;base64,c2Vjb25k'
    await act(async () => vi.advanceTimersByTimeAsync(60_000))
    expect(avatar.querySelector('img')?.getAttribute('src')).toBe(currentImage)
    expect(changed).toHaveBeenCalledTimes(1)
    expect(unchanged).not.toHaveBeenCalled()

    offline = true
    await act(async () => vi.advanceTimersByTimeAsync(60_000))
    expect(avatar.textContent).toBe('AB')
    expect(unchanged).not.toHaveBeenCalled()
    unmount()
    const calls = resolve.mock.calls.length
    await vi.advanceTimersByTimeAsync(60_000)
    expect(resolve).toHaveBeenCalledTimes(calls)
  } finally {
    cleanup()
    vi.useRealTimers()
  }
})

it('ignores replies from an older pairing and keeps the fixed initials slot', async () => {
  vi.useFakeTimers()
  try {
    const previous = deferred<DesktopSenderAvatarResults>()
    const resolve = vi
      .fn<SmartInboxApi['resolveSenderAvatars']>()
      .mockReturnValueOnce(previous.promise)
      .mockResolvedValue({ rows: [] })
    const cache = new SenderAvatarCache(resolve)
    const { getByTestId } = render(
      <SenderAvatar
        cache={cache}
        accountId="a"
        messageId="same"
        address="display-name@fixture.dev"
        data-testid="avatar"
      />,
    )
    await act(async () => vi.advanceTimersByTimeAsync(16))
    act(() => cache.reset())
    await act(async () => previous.resolve({ rows: [{ ...row('same', '1'), image }] }))
    const avatar = getByTestId('avatar')
    expect(avatar.textContent).toBe('DN')
    expect(avatar.querySelector('img')).toBeNull()
    await act(async () => vi.advanceTimersByTimeAsync(16))
    expect(resolve).toHaveBeenCalledTimes(2)
    expect(getByTestId('avatar')).toBe(avatar)
  } finally {
    cleanup()
    vi.useRealTimers()
  }
})
