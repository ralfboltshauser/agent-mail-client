import { SNOOZED_LABEL } from '@amc/protocol'
import { CircleAlert, MailOpen, Star } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { ThreadMessages } from '@/features/thread-reader/thread-messages'
import { fullDate } from '@/lib/format'
import { cn } from '@/lib/utils'
import type { ThreadWithMessages } from '../../../shared/api'
import { MailLoading, MailState } from './mail-state'
import { Button } from './ui/button'
import { Kbd } from './ui/kbd'

interface Props {
  data: ThreadWithMessages | null
  loading?: boolean
  unavailable?: boolean
  onRetry?: () => void
  snoozeEnabled: boolean
  labelNames: Map<string, string>
  scrollRef: React.RefObject<HTMLDivElement | null>
  expanded?: boolean
}

const HIDDEN_LABELS = /:(INBOX|UNREAD|STARRED|IMPORTANT|SENT|DRAFT|CATEGORY_\w+)$/

export function ThreadView({
  data,
  loading,
  unavailable,
  onRetry,
  snoozeEnabled,
  labelNames,
  scrollRef,
  expanded = false,
}: Props) {
  if (!data && unavailable) {
    return (
      <MailState icon={CircleAlert} title="Could not open this thread" error>
        <Button variant="outline" size="sm" onClick={onRetry}>
          Retry
        </Button>
      </MailState>
    )
  }
  if (!data) {
    return loading ? (
      <MailLoading label="Loading thread" />
    ) : (
      <MailState icon={MailOpen} title="No thread selected">
        Use <Kbd>J</Kbd> and <Kbd>K</Kbd> to move through mail.
      </MailState>
    )
  }
  const { thread, messages } = data
  const snoozedUntil = snoozeEnabled ? thread.snoozedUntil : null
  const labels = thread.labelIds
    .filter((id) => !HIDDEN_LABELS.test(id) && id !== `${thread.accountId}:${SNOOZED_LABEL}`)
    .map((id) => labelNames.get(id) ?? id.split(':').pop() ?? id)

  return (
    <div
      ref={scrollRef}
      tabIndex={expanded ? -1 : undefined}
      className="h-full overflow-y-auto outline-none"
    >
      <div className={cn('mx-auto max-w-[48rem] px-6 pb-16 xl:px-8', expanded ? 'pt-12' : 'pt-7')}>
        <div className={cn('flex items-start gap-3', expanded ? 'mb-5' : 'mb-3')}>
          <h1
            className={cn(
              'min-w-0 flex-1 select-text wrap-anywhere font-semibold leading-tight tracking-[-0.035em]',
              expanded ? 'text-[32px]' : 'text-[24px]',
            )}
          >
            {thread.subject || '(no subject)'}
          </h1>
          {thread.starred && <Star className="mt-1.5 size-4 shrink-0 fill-current text-star" />}
        </div>
        {(labels.length > 0 || thread.muted || snoozedUntil) && (
          <div className="mb-4 flex flex-wrap gap-1.5">
            {thread.muted && <Badge variant="secondary">Muted</Badge>}
            {snoozedUntil && (
              <Badge variant="secondary">Snoozed until {fullDate(snoozedUntil)}</Badge>
            )}
            {labels.map((l) => (
              <Badge key={l} variant="secondary" className="font-normal">
                {l}
              </Badge>
            ))}
          </div>
        )}
        {thread.bucket && (
          <div className="mb-5 flex items-start gap-2.5 rounded-md bg-muted/65 px-3 py-2.5">
            <Badge variant="secondary" className="shrink-0 text-accent-foreground">
              {thread.bucket.bucket}
            </Badge>
            <p className="select-text wrap-anywhere pt-px text-xs leading-relaxed text-muted-foreground">
              {thread.bucket.reason}
            </p>
          </div>
        )}
        <div className="space-y-2.5">
          <ThreadMessages key={JSON.stringify([thread.accountId, thread.id])} messages={messages} />
        </div>
      </div>
    </div>
  )
}
