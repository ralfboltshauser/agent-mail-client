import type { Preview } from './model'

export function ReviewAvatar({ card }: { card: Preview }) {
  const name = card.sender?.name || card.sender?.address || ''
  const initials = (name.includes('@') ? name.split('@')[0] : name)
    .split(/[\s._-]+/)
    .slice(0, 2)
    .map((word) => Array.from(word)[0])
    .join('')
    .toUpperCase()
  return (
    <span
      aria-hidden="true"
      className="grid size-10 shrink-0 place-items-center rounded-full bg-accent font-semibold text-accent-foreground"
    >
      {initials || '?'}
    </span>
  )
}
