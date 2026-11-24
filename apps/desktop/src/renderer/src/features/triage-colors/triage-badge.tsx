import { type Bucket, bucketLabels } from '@amc/protocol'
import type { ComponentProps, CSSProperties } from 'react'
import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'
import { bucketColor } from './preferences'

export function TriageBadge({
  bucket,
  className,
  style,
  ...props
}: ComponentProps<'span'> & { bucket: Bucket }) {
  // A newer Engine can return bucket names this Desktop does not recognize.
  if (!Object.hasOwn(bucketLabels, bucket)) {
    return <Badge {...props} variant="secondary" className={className} style={style} />
  }

  return (
    <Badge
      {...props}
      data-triage-bucket={bucketLabels[bucket]}
      variant="secondary"
      className={cn('border-(--triage-badge-border)', className)}
      style={
        {
          ...style,
          '--triage-badge-border': `color-mix(in oklab, ${bucketColor(bucket)} var(--triage-border-strength), transparent)`,
        } as CSSProperties
      }
    />
  )
}
