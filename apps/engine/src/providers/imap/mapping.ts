import { createReadStream } from 'node:fs'
import { addAbortSignal } from 'node:stream'
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
} from 'mailparser'
import type { BlobStore } from '../../blobs.ts'
import type { IncomingAttachment, IncomingLabel, IncomingMessage } from '../../mail/store.ts'
import { BODY_SEARCH_LIMIT, ImapBodyParts } from './body-parts.ts'

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
  trash?: boolean
}

export function mapFolders(list: ListResponse[]): Folder[] {
  const labels = new Set<string>()
  const folders: Folder[] = []
  for (const folder of list) {
    if (folder.flags.has('\\Noselect') || folder.flags.has('\\NonExistent')) continue
    const path = /^inbox$/i.test(folder.path) ? 'INBOX' : folder.path
    const trash =
      [...folder.flags].some((flag) => flag.toLowerCase() === '\\trash') ||
      (folder.specialUse?.toLowerCase() === '\\trash' && folder.specialUseSource !== 'name')
    const special = path === 'INBOX' ? '\\Inbox' : folder.specialUse
    // ImapFlow also guesses special-use from names. Moves require server-designated folders.
    const guessedMoveTarget =
      folder.specialUseSource === 'name' && (special === '\\Archive' || special === '\\Trash')
    const system = special && !guessedMoveTarget && systemLabels.get(special)
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
    folders.push({ path, label, trash })
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

export const LAZY_ATTACHMENT_THRESHOLD = 16 * 1024 * 1024

export async function parseMessage(
  folder: Folder,
  uidValidity: string,
  item: FetchMessageObject,
  blobs: BlobStore,
  sourceBlob: string,
  draftBody?: { text?: string; html?: string },
): Promise<IncomingMessage> {
  let headers: Headers = new Map()
  let lines: HeaderLines = []
  let text: MessageText = { type: 'text' }
  const lazyStructure =
    (item.size ?? 0) > LAZY_ATTACHMENT_THRESHOLD ? item.bodyStructure : undefined
  const attachments = lazyStructure ? largeAttachments(lazyStructure) : []
  const bodies = new ImapBodyParts(blobs)
  const abort = new AbortController()
  const parser = new MailParser({
    skipImageLinks: true,
    skipHtmlToText: true,
    skipTextToHtml: true,
    checksumAlgo: false,
    keepDeliveryStatus: Boolean(draftBody),
    storeTextPart: (stream, charset, flowed, delSp) =>
      bodies.store(addAbortSignal(abort.signal, stream), charset, flowed, delSp),
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
      if (lazyStructure) {
        // MailParser must finish the current part before it can emit the body.
        for await (const _ of part.content) {
          // The IMAP part can be fetched when opened.
        }
      } else {
        const file = await blobs.putStream(part.content)
        attachments.push({
          providerAttachmentId: null,
          filename: part.filename ?? 'attachment',
          mimeType: part.contentType,
          size: file.size,
          contentId: part.cid ?? null,
          inline: !!part.related || part.contentDisposition === 'inline',
          blob: file.hash,
        })
      }
      part.release?.()
    }
  }
  try {
    await Promise.all([pipeline(createReadStream(blobs.path(sourceBlob)), parser), consume()])
  } catch (error) {
    abort.abort()
    parser.destroy()
    throw error
  }

  if (draftBody) {
    draftBody.text = bodies.read(text.text)
    draftBody.html = bodies.read(text.html || undefined)
  }
  const bodiesForStore = await bodies.finish(text.text, text.html)
  const { bodyText } = bodiesForStore
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
    snippet: bodyText.slice(0, 1024).replace(/\s+/g, ' ').slice(0, 200),
    ...bodiesForStore,
    bodySearchLimit: BODY_SEARCH_LIMIT,
    bodyHtml: draftBody?.html ?? null,
    sentAt: Number.isFinite(timestamp) ? timestamp : 0,
    size: item.size ?? 0,
    labels: [folder.label.providerId],
    ...messageFlags(item.flags),
    listUnsubscribe: unsubscribe?.line.replace(/^list-unsubscribe:\s*/i, '') ?? null,
    attachments,
  }
}

function largeAttachments(structure: MessageStructureObject): IncomingAttachment[] {
  const attachments: IncomingAttachment[] = []
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
    }
  }
  visit(structure, false)
  return attachments
}
