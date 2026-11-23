import { type ComponentPropsWithRef, memo, useCallback, useSyncExternalStore } from 'react'
import { type SenderAvatarCache, senderAvatarCache } from './cache'
import { avatarInitials } from './initials'

interface SenderAvatarProps extends Omit<ComponentPropsWithRef<'span'>, 'children'> {
  accountId?: string
  messageId?: string
  address?: string | null
  name?: string | null
  size?: number
  cache?: SenderAvatarCache
}

const emptyImage = () => null
const unsubscribe = () => {}

export const SenderAvatar = memo(function SenderAvatar({
  accountId,
  messageId,
  address,
  name,
  size = 32,
  cache = senderAvatarCache,
  style,
  ...props
}: SenderAvatarProps) {
  const subscribe = useCallback(
    (listener: () => void) =>
      accountId && messageId ? cache.subscribe({ accountId, messageId }, listener) : unsubscribe,
    [accountId, messageId, cache],
  )
  const snapshot = useCallback(
    () => (accountId && messageId ? cache.image({ accountId, messageId }) : null),
    [accountId, messageId, cache],
  )
  const image = useSyncExternalStore(subscribe, snapshot, emptyImage)
  const fallback = avatarInitials(address, name)
  return (
    <span
      {...props}
      aria-hidden="true"
      style={{
        ...style,
        width: size,
        height: size,
        flex: 'none',
        display: 'inline-grid',
        placeItems: 'center',
        overflow: 'hidden',
        borderRadius: '50%',
        color: 'white',
        backgroundColor: fallback.color,
        fontSize: Math.round(size * 0.4),
        fontWeight: 600,
        lineHeight: 1,
      }}
    >
      {image ? (
        <img src={image} alt="" width={size} height={size} style={{ objectFit: 'contain' }} />
      ) : (
        fallback.initials
      )}
    </span>
  )
})
