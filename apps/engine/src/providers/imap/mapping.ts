import { createReadStream } from 'node:fs'
import { pipeline } from 'node:stream/promises'
import type { Address } from '@amc/protocol'
import type { FetchMessageObject, ListResponse, MessageStructureObject } from 'imapflow'
import {
  type AddressObject,
  type AttachmentStream,
  type HeaderLines,
  type Headers,
  MailParser,
  type MessageText,
  simpleParser,
} from 'mailparser'
import type { BlobStore } from '../../blobs.ts'
import type { IncomingAttachment, IncomingLabel, IncomingMessage } from '../../mail/store.ts'
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

export const MESSAGE_LIMIT = 16 * 1024 * 1024
const PREVIEW_LIMIT = 256 * 1024

export async function parseMessage(
  folder: Folder,
  uidValidity: string,
  item: FetchMessageObject,
  blobs: BlobStore,
  sourceBlob: string | null,
  preview: MessageText = { type: 'text' },
): Promise<IncomingMessage> {
  let headers: Headers = new Map()
  let lines: HeaderLines = []
  let text = preview
  const attachments: IncomingAttachment[] = []

  if (sourceBlob) {
    const parser = new MailParser({
      skipImageLinks: true,
      skipHtmlToText: true,
      skipTextToHtml: true,
    })
    parser.on('headers', (value: Headers) => {
      headers = value
    })
    parser.on('headerLines', (value: HeaderLines) => {
      lines = value
    })
    const consume = async () => {
      for await (const part of parser as AsyncIterable<AttachmentStream | MessageText>) {
        if (part.type === 'text') {
          text = part
          continue
        }
        const file = await blobs.putStream(part.content, MESSAGE_LIMIT)
        attachments.push({
          providerAttachmentId: null,
          filename: part.filename ?? 'attachment',
          mimeType: part.contentType,
          size: file.size,
          contentId: part.cid ?? null,
          inline: !!part.related || part.contentDisposition === 'inline',
          blob: file.hash,
        })
        part.release?.()
      }
    }
    await Promise.all([
      pipeline(createReadStream(blobs.path(sourceBlob)), parser),
      consume().catch((error: Error) => {
        parser.destroy(error)
        throw error
      }),
    ])
  } else {
    const mail = await simpleParser(item.headers ?? Buffer.alloc(0), { skipImageLinks: true })
    headers = mail.headers
    lines = mail.headerLines
    attachments.push(...largeParts(item.bodyStructure).attachments)
  }

  const bodyHtml = text.html || null
  const bodyText = normalizeWhitespace(text.text ?? (bodyHtml ? htmlToText(bodyHtml) : ''))
  const unsubscribe = lines.find((header) => header.key === 'list-unsubscribe')
  const date = headers.get('date')
  const timestamp =
    date instanceof Date ? date.getTime() : new Date(item.internalDate ?? 0).getTime()
  const rfcId = headers.get('message-id')
  const reply = headers.get('in-reply-to')
  const references = headers.get('references')
  const subject = headers.get('subject')
  return {
    providerId: providerMessageId(folder.path, uidValidity, item.uid),
    providerThreadId: '',
    rfcMessageId: typeof rfcId === 'string' ? rfcId : null,
    inReplyTo: typeof reply === 'string' ? reply : null,
    references: Array.isArray(references)
      ? references.join(' ')
      : typeof references === 'string'
        ? references
        : null,
    from: addresses(headers.get('from') as AddressObject | undefined)[0] ?? null,
    to: addresses(headers.get('to') as AddressObject | AddressObject[] | undefined),
    cc: addresses(headers.get('cc') as AddressObject | AddressObject[] | undefined),
    bcc: addresses(headers.get('bcc') as AddressObject | AddressObject[] | undefined),
    replyTo: addresses(headers.get('reply-to') as AddressObject | AddressObject[] | undefined),
    subject: typeof subject === 'string' ? subject : '',
    snippet: bodyText.replace(/\s+/g, ' ').slice(0, 200),
    bodyText,
    bodyHtml,
    sentAt: Number.isFinite(timestamp) ? timestamp : 0,
    size: item.size ?? 0,
    labels: [folder.label.providerId],
    ...messageFlags(item.flags),
    listUnsubscribe: unsubscribe?.line.replace(/^list-unsubscribe:\s*/i, '') ?? null,
    attachments,
  }
}

export function largeParts(structure: MessageStructureObject | undefined) {
  const attachments: IncomingAttachment[] = []
  const preview: { text?: string; html?: string } = {}
  function visit(node: MessageStructureObject, related: boolean) {
    const type = node.type.toLowerCase()
    const part = node.part ?? '1'
    const filename = node.dispositionParameters?.filename ?? node.parameters?.name
    const disposition = node.disposition?.toLowerCase()
    if (
      disposition === 'attachment' ||
      filename ||
      (!type.startsWith('multipart/') && !['text/plain', 'text/html'].includes(type))
    ) {
      attachments.push({
        providerAttachmentId: part,
        filename: filename ?? 'attachment',
        mimeType: type,
        size: node.size ?? 0,
        contentId: node.id?.replace(/^<|>$/g, '') ?? null,
        inline: disposition === 'inline' || (related && Boolean(node.id)),
      })
    } else if (node.childNodes) {
      for (const child of node.childNodes) visit(child, related || type === 'multipart/related')
    } else if (type === 'text/plain') {
      preview.text ??= part
    } else if (type === 'text/html') {
      preview.html ??= part
    }
  }
  if (structure) visit(structure, false)
  return { attachments, preview }
}

export async function largePreview(
  client: import('./client.ts').ImapClient,
  item: FetchMessageObject,
): Promise<MessageText> {
  const text: MessageText = { type: 'text' }
  const { preview } = largeParts(item.bodyStructure)
  for (const kind of ['text', 'html'] as const) {
    const part = preview[kind]
    if (!part) continue
    const { content } = await client.download(String(item.uid), part, {
      uid: true,
      maxBytes: PREVIEW_LIMIT,
    })
    if (!content) continue
    const decoder = new TextDecoder()
    let bytes = 0
    let value = ''
    for await (const chunk of content) {
      const data = Buffer.from(chunk)
      value += decoder.decode(data.subarray(0, Math.max(0, PREVIEW_LIMIT - bytes)), {
        stream: true,
      })
      bytes += data.length
    }
    text[kind] = value + decoder.decode()
  }
  return text
}
