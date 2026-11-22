import type { LucideIcon } from 'lucide-react'
import { Skeleton } from './ui/skeleton'

export function MailState({
  icon: Icon,
  title,
  children,
  error = false,
}: {
  icon: LucideIcon
  title: string
  children?: React.ReactNode
  error?: boolean
}) {
  'use memo'

  return (
    <div
      className="grid h-full min-h-32 place-items-center px-6 py-8 text-center"
      role={error ? 'alert' : undefined}
    >
      <div className="grid max-w-64 justify-items-center gap-2">
        <span className={error ? 'mail-state-icon text-destructive' : 'mail-state-icon'}>
          <Icon size={19} aria-hidden />
        </span>
        <p className="text-sm font-semibold">{title}</p>
        {children && (
          <div className="text-xs leading-relaxed text-muted-foreground">{children}</div>
        )}
      </div>
    </div>
  )
}

export function MailLoading({ label }: { label: string }) {
  'use memo'

  return (
    <div className="divide-y px-4">
      <output className="sr-only">{label}</output>
      {[1, 2, 3, 4, 5].map((row) => (
        <div key={row} className="grid gap-2 px-2 py-4" aria-hidden>
          <Skeleton className="h-3 w-1/3" />
          <Skeleton className="h-3 w-2/3" />
          <Skeleton className="h-2.5 w-1/2" />
        </div>
      ))}
    </div>
  )
}
