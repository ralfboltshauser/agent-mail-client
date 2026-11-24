import { Bucket, bucketLabels } from '@amc/protocol'
import type { ComponentProps, CSSProperties } from 'react'
import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'
import { bucketColor } from './preferences'

export function TriageBadge({
  bucket,
  className,
  style,
  ...props
}: ComponentProps<'span'> & { bucket: string }) {
  // A newer Engine can return bucket names this Desktop does not recognize.
  const builtin = Bucket.safeParse(bucket)
  if (!builtin.success) {
    return <Badge {...props} variant="secondary" className={className} style={style} />
  }

  return (
    <Badge
      {...props}
      data-triage-bucket={bucketLabels[builtin.data]}
      variant="secondary"
      className={cn('border-(--triage-badge-border)', className)}
      style={
        {
          ...style,
          '--triage-badge-border': `color-mix(in oklab, ${bucketColor(builtin.data)} var(--triage-border-strength), transparent)`,
        } as CSSProperties
      }
    />
  )
}
