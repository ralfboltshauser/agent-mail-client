import type { ReactNode } from 'react'

export function DeliveryView({
  title,
  actions,
  error,
  children,
}: {
  title: string
  actions?: ReactNode
  error: string
  children: ReactNode
}) {
  return (
    <section className="flex h-full flex-col">
      <header className="app-drag app-toolbar justify-between px-5">
        <h2 className="text-[15px] font-semibold tracking-tight">{title}</h2>
        {actions}
      </header>
      <div className="min-h-0 flex-1 overflow-auto">{children}</div>
      <div role="alert" className="shrink-0">
        {error && (
          <p className="truncate border-t px-5 py-2 text-xs text-destructive" title={error}>
            Could not refresh {title}. {error}
          </p>
        )}
      </div>
    </section>
  )
}
