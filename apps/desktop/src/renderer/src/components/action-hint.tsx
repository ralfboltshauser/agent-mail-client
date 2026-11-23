import type { ReactElement } from 'react'
import { Kbd } from '@/components/ui/kbd'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { ariaShortcut, shortcutLabel, tooltipDismissals } from '@/lib/mail-shortcuts'

export function ActionHint({
  label,
  shortcuts = [],
  children,
}: {
  label: string
  shortcuts?: readonly string[]
  children: ReactElement
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        asChild
        aria-keyshortcuts={shortcuts.map(ariaShortcut).join(' ') || undefined}
      >
        {children}
      </TooltipTrigger>
      <TooltipContent
        side="bottom"
        sideOffset={4}
        onEscapeKeyDown={(event) => {
          tooltipDismissals.add(event)
        }}
      >
        <span className="inline-flex flex-wrap items-center gap-1.5">
          {label}
          {shortcuts.map((binding) => (
            <Kbd key={binding}>{shortcutLabel(binding)}</Kbd>
          ))}
        </span>
      </TooltipContent>
    </Tooltip>
  )
}
