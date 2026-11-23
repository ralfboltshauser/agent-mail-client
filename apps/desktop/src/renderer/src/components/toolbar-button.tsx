import type { ComponentProps } from 'react'
import { ActionHint } from '@/components/action-hint'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

export function ToolbarButton({
  label,
  shortcuts,
  className,
  ...props
}: Omit<ComponentProps<typeof Button>, 'size' | 'variant' | 'asChild'> & {
  label: string
  shortcuts?: readonly string[]
}) {
  return (
    <ActionHint label={label} shortcuts={shortcuts}>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        aria-label={label}
        className={cn('app-no-drag text-muted-foreground', className)}
        {...props}
      />
    </ActionHint>
  )
}
