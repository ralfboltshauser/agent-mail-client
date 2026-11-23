import { SenderAvatar } from '../sender-avatar/sender-avatar'
import type { Preview } from './model'

export function ReviewAvatar({ card }: { card: Preview }) {
  const from = card.detail.messages.find(({ id }) => id === card.messageId)?.from
  return (
    <SenderAvatar
      accountId={card.accountId}
      messageId={card.messageId}
      address={card.sender?.address ?? from?.address}
      name={from?.name}
      size={40}
    />
  )
}
