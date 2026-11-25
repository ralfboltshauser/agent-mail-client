import { ChevronDown } from 'lucide-react'
import { Popover } from 'radix-ui'
import { personName } from '@/lib/format'
import type { ReplicaThreadMessage } from '../../../../shared/api'

export function MessageDetails({ message }: { message: ReplicaThreadMessage }) {
  const { from, to, cc, bcc, replyTo } = message
  const fields = [
    { label: 'From', addresses: from ? [from] : [], empty: 'Unknown sender' },
    { label: 'To', addresses: to, empty: 'None listed' },
    { label: 'Cc', addresses: cc },
    { label: 'Bcc', addresses: bcc },
    { label: 'Reply-To', addresses: replyTo },
  ]

  return (
    <Popover.Root>
      <Popover.Trigger
        className="flex max-w-full items-center gap-1 rounded-sm text-left text-xs text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
        aria-label="Show message details"
      >
        <span className="truncate">
          {from && <>{from.address} · </>}
          {to.length > 0 && <>to {to.map(personName).join(', ')}</>}
          {to.length > 0 && cc.length > 0 && ' · '}
          {cc.length > 0 && <>cc {cc.map(personName).join(', ')}</>}
          {to.length === 0 && cc.length === 0 && 'undisclosed recipients'}
        </span>
        <ChevronDown className="size-3 shrink-0" aria-hidden />
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          align="start"
          sideOffset={6}
          collisionPadding={12}
          aria-label="Message details"
          tabIndex={0}
          className="z-50 max-h-[var(--radix-popover-content-available-height)] w-96 max-w-[var(--radix-popover-content-available-width)] overflow-y-auto rounded-md border bg-popover p-3 text-popover-foreground text-sm shadow-md"
        >
          <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2 select-text">
            {fields.map(({ label, addresses, empty }) =>
              addresses.length || empty ? (
                <div key={label} className="contents">
                  <dt className="text-muted-foreground">{label}</dt>
                  <dd className="space-y-1 [overflow-wrap:anywhere]">
                    {addresses.length
                      ? addresses.map(({ name, address }, index) => (
                          // biome-ignore lint/suspicious/noArrayIndexKey: Header entries can repeat and carry no state.
                          <div key={`${address}-${index}`}>
                            {name?.trim() && name.trim() !== address ? (
                              <>
                                <span>{name.trim()}</span>{' '}
                                <span className="text-muted-foreground">{address}</span>
                              </>
                            ) : (
                              address
                            )}
                          </div>
                        ))
                      : empty}
                  </dd>
                </div>
              ) : null,
            )}
          </dl>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  )
}
