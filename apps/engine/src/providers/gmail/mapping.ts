import { cleanMessageId, parseAddress, parseAddressList } from '../../mail/addresses.ts'
import type { IncomingAttachment, IncomingMessage } from '../../mail/store.ts'
import { decodeEntities, htmlToText, normalizeWhitespace } from '../../mail/text.ts'
import type { GmailHeader, GmailMessage, GmailPart } from './types.ts'

function header(headers: GmailHeader[] | undefined, name: string): string | null {
  const lower = name.toLowerCase()
  return headers?.find((h) => h.name.toLowerCase() === lower)?.value ?? null
}

function charsetOf(part: GmailPart): string {
  const contentType = header(part.headers, 'Content-Type') ?? ''
  return /charset="?([^";\s]+)"?/i.exec(contentType)?.[1]?.toLowerCase() ?? 'utf-8'
}

function decodeBody(part: GmailPart): string {
  const data = part.body?.data
  if (!data) return ''
  const bytes = Buffer.from(data, 'base64url')
  try {
    return new TextDecoder(charsetOf(part), { fatal: false }).decode(bytes)
  } catch {
    return new TextDecoder('utf-8').decode(bytes)
  }
}

function isAttachment(part: GmailPart): boolean {
  if (part.filename) return true
  const disposition = header(part.headers, 'Content-Disposition') ?? ''
  return /^attachment/i.test(disposition) || Boolean(part.body?.attachmentId)
}

interface Collected {
  plain: string[]
  html: string[]
  attachments: IncomingAttachment[]
}

function walk(part: GmailPart, into: Collected): void {
  const type = part.mimeType.toLowerCase()
  if (type.startsWith('multipart/')) {
    const children = part.parts ?? []
    if (type === 'multipart/alternative') {
      // Take the richest version of each kind, not every alternative.
      const plain = children.find(
        (c) => c.mimeType.toLowerCase() === 'text/plain' && !isAttachment(c),
      )
      const html = children.find(
        (c) => c.mimeType.toLowerCase() === 'text/html' && !isAttachment(c),
      )
      const nested = children.filter((c) => c.mimeType.toLowerCase().startsWith('multipart/'))
      if (plain) into.plain.push(decodeBody(plain))
      if (html) into.html.push(decodeBody(html))
      for (const child of nested) walk(child, into)
      return
    }
    for (const child of children) walk(child, into)
    return
  }
  if (isAttachment(part)) {
    const disposition = header(part.headers, 'Content-Disposition') ?? ''
    const contentId = cleanMessageId(header(part.headers, 'Content-ID'))
    into.attachments.push({
      providerAttachmentId: part.body?.attachmentId ?? null,
      filename: part.filename ?? '',
      mimeType: type,
      size: part.body?.size ?? 0,
      contentId,
      inline:
        /^inline/i.test(disposition) || (contentId !== null && !/^attachment/i.test(disposition)),
      ...(part.body?.data ? { data: Buffer.from(part.body.data, 'base64url') } : {}),
    })
    return
  }
  if (type === 'text/plain') into.plain.push(decodeBody(part))
  else if (type === 'text/html') into.html.push(decodeBody(part))
}

/** Maps a Gmail `format=full` message to what the store keeps. */
export function fromGmail(message: GmailMessage): IncomingMessage {
  const payload = message.payload ?? { mimeType: 'text/plain' }
  const headers = payload.headers
  const collected: Collected = { plain: [], html: [], attachments: [] }
  walk(payload, collected)

  const html = collected.html.filter(Boolean).join('\n<hr>\n') || null
  const plain = normalizeWhitespace(collected.plain.join('\n\n'))
  const bodyText = plain || (html ? htmlToText(html) : '')
  const sentAt = Number(message.internalDate) || Date.parse(header(headers, 'Date') ?? '') || 0

  return {
    providerId: message.id,
    providerHistoryId: message.historyId,
    providerThreadId: message.threadId,
    rfcMessageId: cleanMessageId(header(headers, 'Message-ID')),
    inReplyTo: cleanMessageId(header(headers, 'In-Reply-To')),
    references: header(headers, 'References'),
    from: parseAddress(header(headers, 'From')),
    to: parseAddressList(header(headers, 'To')),
    cc: parseAddressList(header(headers, 'Cc')),
    bcc: parseAddressList(header(headers, 'Bcc')),
    replyTo: parseAddressList(header(headers, 'Reply-To')),
    subject: header(headers, 'Subject')?.trim() ?? '',
    snippet: decodeEntities(message.snippet ?? ''),
    bodyText,
    bodyHtml: html,
    sentAt,
    size: message.sizeEstimate ?? 0,
    labels: message.labelIds ?? [],
    listUnsubscribe: header(headers, 'List-Unsubscribe'),
    attachments: collected.attachments,
  }
}
