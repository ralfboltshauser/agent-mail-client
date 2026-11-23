import { ContextMenu } from 'radix-ui'
import { type ReactElement, type RefObject, useState } from 'react'
import { Kbd } from '@/components/ui/kbd'
import type { FilterAction } from '@/features/mailbox/use-filter-actions'

export function ThreadContextMenu({
  children,
  listRef,
  selectedId,
  getActions,
}: {
  children: ReactElement
  listRef: RefObject<HTMLDivElement | null>
  selectedId: string | null
  getActions: (id: string) => FilterAction[]
}) {
  const [actions, setActions] = useState<FilterAction[]>([])
  return (
    <ContextMenu.Root>
      <ContextMenu.Trigger
        asChild
        onContextMenu={(event) => {
          const target = event.target as HTMLElement
          const row = target.closest<HTMLElement>('[data-thread-id]')
          const id = row?.dataset.threadId ?? (target === event.currentTarget ? selectedId : null)
          const next = id ? getActions(id) : []
          if (!next.length) event.preventDefault()
          setActions(next)
        }}
      >
        {children}
      </ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Content
          aria-label="Thread actions"
          className="z-50 min-w-36 rounded-md border bg-popover p-1 text-popover-foreground shadow-md"
          onCloseAutoFocus={(event) => {
            event.preventDefault()
            listRef.current?.focus({ preventScroll: true })
          }}
        >
          {actions.map(({ name, shortcut, disabled, run }) => (
            <ContextMenu.Item
              key={name}
              disabled={disabled}
              onSelect={run}
              className="flex cursor-default items-center justify-between gap-3 rounded-sm px-2 py-1.5 text-sm outline-hidden select-none focus:bg-accent focus:text-accent-foreground data-disabled:opacity-50"
            >
              {name}
              {shortcut && <Kbd aria-hidden="true">{shortcut}</Kbd>}
            </ContextMenu.Item>
          ))}
        </ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  )
}
