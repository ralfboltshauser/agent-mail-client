import type { Address } from '@amc/protocol'
import type { FetchMessageObject, ListResponse } from 'imapflow'
import { type AddressObject, simpleParser } from 'mailparser'
import type { IncomingLabel, IncomingMessage } from '../../mail/store.ts'
import { htmlToText, normalizeWhitespace } from '../../mail/text.ts'

const systemLabels = new Map([
  ['\\Inbox', ['INBOX', 'Inbox']],
  ['\\Sent', ['SENT', 'Sent']],
  ['\\Drafts', ['DRAFT', 'Drafts']],
  ['\\Trash', ['TRASH', 'Trash']],
  ['\\Junk', ['SPAM', 'Junk']],
  ['\\Archive', ['ARCHIVE', 'Archive']],
  ['\\All', ['ALL', 'All Mail']],
])

export interface Folder {
  path: string
  label: IncomingLabel
}

export function mapFolders(list: ListResponse[]): Folder[] {
  const labels = new Set<string>()
  const folders: Folder[] = []
  for (const folder of list) {
    if (folder.flags.has('\\Noselect') || folder.flags.has('\\NonExistent')) continue
    const path = /^inbox$/i.test(folder.path) ? 'INBOX' : folder.path
    const special = path === 'INBOX' ? '\\Inbox' : folder.specialUse
    const system = special && systemLabels.get(special)
    const [systemId, name] = system || []
    const label: IncomingLabel =
      systemId && name && !labels.has(systemId)
        ? { providerId: systemId, name, kind: 'system', color: null }
        : {
            providerId: `folder:${encodeURIComponent(path)}`,
            name: path,
            kind: 'user',
            color: null,
          }
    labels.add(label.providerId)
    folders.push({ path, label })
  }
  return folders.sort((a, b) => Number(b.path === 'INBOX') - Number(a.path === 'INBOX'))
}

export function messagePrefix(path: string): string {
  return `${encodeURIComponent(path)}:`
}

export function providerMessageId(path: string, uidValidity: string, uid: number): string {
  return `${messagePrefix(path)}${uidValidity}:${uid}`
}

export function messageFlags(flags: Set<string> | undefined) {
  return { unread: !flags?.has('\\Seen'), starred: flags?.has('\\Flagged') ?? false }
}

function addresses(input: AddressObject | AddressObject[] | undefined): Address[] {
  return [input ?? []].flat(2).flatMap(({ value }) =>
    value.flatMap(function flatten(entry): Address[] {
      if (entry.group) return entry.group.flatMap(flatten)
      return entry.address ? [{ address: entry.address, name: entry.name || null }] : []
    }),
  )
}

export async function parseMessage(
  folder: Folder,
  uidValidity: string,
  item: FetchMessageObject,
): Promise<IncomingMessage> {
  if (!item.source) throw new Error('IMAP FETCH returned a message without its source')
  const mail = await simpleParser(item.source, { skipImageLinks: true, skipHtmlToText: true })
  const bodyHtml = mail.html || null
  const bodyText = normalizeWhitespace(mail.text ?? (bodyHtml ? htmlToText(bodyHtml) : ''))
  const unsubscribe = mail.headerLines.find((header) => header.key === 'list-unsubscribe')
  const date = mail.date ?? item.internalDate
  const timestamp = date ? new Date(date).getTime() : 0
  return {
    providerId: providerMessageId(folder.path, uidValidity, item.uid),
    providerThreadId: '',
    rfcMessageId: mail.messageId ?? null,
    inReplyTo: mail.inReplyTo ?? null,
    references: [mail.references ?? []].flat().join(' ') || null,
    from: addresses(mail.from)[0] ?? null,
    to: addresses(mail.to),
    cc: addresses(mail.cc),
    bcc: addresses(mail.bcc),
    replyTo: addresses(mail.replyTo),
    subject: mail.subject ?? '',
    snippet: bodyText.replace(/\s+/g, ' ').slice(0, 200),
    bodyText,
    bodyHtml,
    sentAt: Number.isFinite(timestamp) ? timestamp : 0,
    size: item.source.length,
    labels: [folder.label.providerId],
    ...messageFlags(item.flags),
    listUnsubscribe: unsubscribe?.line.replace(/^list-unsubscribe:\s*/i, '') ?? null,
    attachments: mail.attachments.map((attachment) => ({
      providerAttachmentId: null,
      filename: attachment.filename ?? 'attachment',
      mimeType: attachment.contentType,
      size: attachment.size,
      contentId: attachment.contentId?.replace(/^<|>$/g, '') ?? null,
      inline: attachment.related || attachment.contentDisposition === 'inline',
      data: attachment.content,
    })),
  }
}
