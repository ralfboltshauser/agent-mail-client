import { Paperclip, Star } from 'lucide-react'
import { memo } from 'react'
import { Badge } from '@/components/ui/badge'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import type { MailboxThreadQuery } from '@/features/mailbox/mailbox-queries'
import { SenderAvatar } from '@/features/sender-avatar/sender-avatar'
import { useReplicaSelector } from '@/hooks/use-amc'
import { listDate, participantsLine } from '@/lib/format'
import { cn } from '@/lib/utils'
import type { DesktopThreadSummary } from '../../../../shared/api'

export const SubscribedThreadRow = memo(function SubscribedThreadRow({
  id,
  query,
  fallback,
  self,
  match,
  avatarVisible,
}: {
  id: string
  query: MailboxThreadQuery | null
  fallback?: DesktopThreadSummary
  self: Set<string>
  match?: string
  avatarVisible: boolean
}) {
  const thread = useReplicaSelector(query, ({ data }) => data?.summaries.get(id) ?? fallback)
  if (!thread) return null
  const inboxSender =
    thread.inboxSender?.accountId === thread.accountId ? thread.inboxSender : undefined
  const messageId = thread.latestSender?.messageId ?? inboxSender?.messageId
  const from = thread.latestSender
    ? thread.latestSender.from
    : inboxSender
      ? {
          address: inboxSender.address,
          name: thread.participants.find(
            ({ address }) => address.toLowerCase() === inboxSender.address,
          )?.name,
        }
      : (thread.participants.find(({ address }) => !self.has(address.toLowerCase())) ??
        thread.participants[0])
  return (
    <ThreadRow
      unread={thread.unreadCount > 0}
      avatarAccountId={thread.accountId}
      avatarMessageId={avatarVisible && from?.address ? messageId : undefined}
      avatarAddress={from?.address}
      avatarName={from?.name ?? undefined}
      participants={participantsLine(thread.participants, self)}
      messageCount={thread.messageCount}
      hasAttachments={thread.hasAttachments}
      starred={thread.starred}
      dateTime={new Date(thread.lastMessageAt).toISOString()}
      dateLabel={listDate(thread.lastMessageAt)}
      subject={thread.subject || '(no subject)'}
      snippet={thread.snippet}
      match={match}
      bucket={thread.bucket?.bucket}
      bucketReason={thread.bucket?.reason}
    />
  )
})

interface RowProps {
  unread: boolean
  avatarAccountId: string
  avatarMessageId?: string
  avatarAddress?: string
  avatarName?: string
  participants: string
  messageCount: number
  hasAttachments: boolean
  starred: boolean
  dateTime: string
  dateLabel: string
  subject: string
  snippet: string
  match?: string
  bucket?: string
  bucketReason?: string
}

export const ThreadRow = memo(function ThreadRow({
  unread,
  avatarAccountId,
  avatarMessageId,
  avatarAddress,
  avatarName,
  participants,
  messageCount,
  hasAttachments,
  starred,
  dateTime,
  dateLabel,
  subject,
  snippet,
  match,
  bucket,
  bucketReason,
}: RowProps) {
  return (
    <>
      <div className="flex w-2 shrink-0 justify-center self-center">
        {unread && (
          <span className="size-[7px] rounded-full bg-unread">
            <span className="sr-only">Unread</span>
          </span>
        )}
      </div>
      <SenderAvatar
        accountId={avatarAccountId}
        messageId={avatarMessageId}
        address={avatarAddress}
        name={avatarName}
        className="self-center"
      />
      <div className="min-w-0 flex-1">
        <div className="flex h-[19px] items-center gap-1.5">
          <span
            className={cn(
              'truncate text-[13px]',
              unread ? 'font-semibold text-foreground' : 'font-medium text-foreground/85',
            )}
          >
            {participants}
          </span>
          {messageCount > 1 && (
            <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
              {messageCount}
            </span>
          )}
          <span className="ml-auto flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground tabular-nums">
            {hasAttachments && (
              <>
                <Paperclip aria-hidden className="size-3" />
                <span className="sr-only">Attachment</span>
              </>
            )}
            {starred && (
              <>
                <Star aria-hidden className="size-3 fill-current text-star" />
                <span className="sr-only">Starred</span>
              </>
            )}
            <time dateTime={dateTime}>{dateLabel}</time>
          </span>
        </div>
        <div
          className={cn(
            'truncate text-[13px]',
            unread ? 'font-semibold text-foreground' : 'text-foreground/85',
          )}
        >
          {subject}
        </div>
        <div className="flex items-center gap-2">
          <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
            {match ? <MatchSnippet text={match} /> : snippet}
          </span>
          {bucket && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Badge
                  variant="secondary"
                  className="h-[18px] max-w-[45%] shrink text-[10px] text-muted-foreground"
                >
                  <span className="truncate">
                    <span className="sr-only">Triage: </span>
                    {bucket}
                  </span>
                </Badge>
              </TooltipTrigger>
              <TooltipContent className="max-w-64 break-words">
                <div className="font-semibold">Triage: {bucket}</div>
                {bucketReason}
              </TooltipContent>
            </Tooltip>
          )}
        </div>
      </div>
    </>
  )
})

/** Renders the Engine's «match» markers as highlights. */
function MatchSnippet({ text }: { text: string }) {
  const parts = text.split(/«|»/).map((part, i) => ({ part, key: `${i}:${part}` }))
  return (
    <>
      {parts.map(({ part, key }, i) =>
        i % 2 === 1 ? (
          <mark key={key} className="rounded-sm bg-foreground/15 px-0.5 text-foreground">
            {part}
          </mark>
        ) : (
          part
        ),
      )}
    </>
  )
}
