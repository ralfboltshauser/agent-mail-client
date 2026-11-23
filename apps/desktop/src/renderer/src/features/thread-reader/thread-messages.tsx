import { type ReactNode, useState } from 'react'
import type { ReplicaThreadMessage } from '../../../../shared/api'
import { initiallyOpen } from './body-queries'
import { Message } from './message'

function inlineMessageIds(
  messages: ReplicaThreadMessage[],
  previous?: ReadonlySet<string>,
  seen?: ReadonlySet<string>,
) {
  return new Set(
    messages
      .filter(
        (message, index) =>
          previous?.has(message.id) ||
          message.labelIds.includes(`${message.accountId}:DRAFT`) ||
          message.unread ||
          index === messages.length - 1 ||
          (!seen?.has(message.id) && message.bodyText !== null),
      )
      .map((message) => message.id),
  )
}

export function ThreadMessages({
  messages,
  onEditDraft,
  draftEditingDisabled,
}: {
  messages: ReplicaThreadMessage[]
  onEditDraft?: (messageId: string, imapRevision?: string) => void
  draftEditingDisabled?: boolean
}) {
  const [layout, setLayout] = useState(() => ({
    messages,
    inline: inlineMessageIds(messages),
    seen: new Set(messages.map((message) => message.id)),
  }))
  const [revealed, setRevealed] = useState<ReadonlySet<string>>(() => new Set())
  if (layout.messages !== messages) {
    // The replica can defer previously eager text as messages arrive or become read.
    // Keep the existing cards in place when only body availability changes.
    setLayout({
      messages,
      inline: inlineMessageIds(messages, layout.inline, layout.seen),
      seen: new Set(messages.map((message) => message.id)),
    })
  }

  function renderMessage(message: ReplicaThreadMessage, defaultOpen = false) {
    return (
      <Message
        key={message.id}
        message={message}
        defaultOpen={defaultOpen}
        onEditDraft={onEditDraft}
        draftEditingDisabled={draftEditingDisabled}
      />
    )
  }

  const rows: ReactNode[] = []
  for (const [index, group] of groupMessages(messages, layout.inline)) {
    const first = group[0]
    if (!first) continue
    if (layout.inline.has(first.id)) {
      rows.push(renderMessage(first, initiallyOpen(first, index, messages.length)))
      continue
    }
    const shown = group.some((message) => revealed.has(message.id))
    rows.push(
      <button
        key={`older:${first.id}`}
        type="button"
        aria-expanded={shown}
        onClick={() =>
          setRevealed((current) => {
            const next = new Set(current)
            for (const message of group) {
              if (shown) next.delete(message.id)
              else next.add(message.id)
            }
            return next
          })
        }
        className="w-full rounded-lg border bg-card px-4 py-3 text-left text-sm text-muted-foreground hover:bg-muted"
      >
        {group.length} older {group.length === 1 ? 'message' : 'messages'}
      </button>,
    )
    if (shown) rows.push(...group.map((message) => renderMessage(message)))
  }
  // Message cards are siblings regardless of group membership, so promotion keeps their keys.
  return rows
}

function* groupMessages(messages: ReplicaThreadMessage[], inline: ReadonlySet<string>) {
  for (let index = 0; index < messages.length; ) {
    const start = index++
    const message = messages[start]
    if (!message) break
    if (!inline.has(message.id)) {
      while (index < messages.length) {
        const next = messages[index]
        if (!next || inline.has(next.id)) break
        index++
      }
    }
    yield [start, messages.slice(start, index)] as const
  }
}
