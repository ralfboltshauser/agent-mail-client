import { createHash } from 'node:crypto'
import type { MessageStructureObject } from 'imapflow'
import { compileMessage, newMessageId, type OutgoingMessage } from '../../mail/mime.ts'
import {
  connectImap,
  createImapClient,
  createSmtpClient,
  type ImapClient,
  type ImapClientFactory,
  type ImapCredentials,
  imapEndpoint,
  imapMoveSupport,
} from './client.ts'
import { type Folder, mapFolders } from './mapping.ts'

export interface Submission {
  sendMail(message: {
    raw: Buffer
    envelope: { from: string; to: string[] }
  }): Promise<{ accepted: string[]; rejected: string[] }>
  close(): void
}

export interface ImapSendResult {
  messageId: string
  accepted: string[]
  rejected: string[]
  sentCopy: 'appended' | 'server-managed' | 'failed'
}

export interface ImapMessageLocation {
  folder: string
  uidValidity: string
  uid: number
}

interface ImapDraftLocation {
  folder: Folder
  uidValidity: string
  uid: number
  size: number
  id: string
}

export function draftSourceHash(raw: Buffer): string {
  return createHash('sha256').update(raw).digest('hex')
}

export class SmtpRejection extends Error {}

function smtpRejection(error: unknown): SmtpRejection | null {
  if (!error || typeof error !== 'object') return null
  const { command, responseCode, code } = error as {
    command?: string
    responseCode?: number
    code?: string
  }
  const status =
    typeof responseCode === 'number' && responseCode >= 400 && responseCode < 600
      ? ` (SMTP ${responseCode})`
      : ''
  if (code === 'EAUTH' || command?.startsWith('AUTH ')) {
    return new SmtpRejection(`SMTP authentication failed${status}. Sign in to this Account again.`)
  }
  if (command === 'MAIL FROM') return new SmtpRejection(`SMTP rejected the sender${status}.`)
  if (command === 'RCPT TO') return new SmtpRejection(`SMTP rejected all recipients${status}.`)
  if (command === 'DATA' && status) return new SmtpRejection(`SMTP rejected the message${status}.`)
  return null
}

const SENT_LOOKUP_MS = 5_000

/** Provider operations for a future owner send pipeline and provider writeback. */
export class ImapProvider {
  readonly #credentials: ImapCredentials
  readonly #imap: ImapClientFactory
  readonly #smtp: (credentials: ImapCredentials['smtp']) => Submission

  constructor(
    credentials: ImapCredentials,
    imap: ImapClientFactory = createImapClient,
    smtp: (credentials: ImapCredentials['smtp']) => Submission = createSmtpClient,
  ) {
    this.#credentials = credentials
    this.#imap = imap
    this.#smtp = smtp
  }

  async send(message: OutgoingMessage): Promise<ImapSendResult> {
    const messageId = message.messageId ?? newMessageId(message.from.address)
    const mime = compileMessage({ ...message, messageId })
    const envelope = mime.getEnvelope()
    if (!envelope.from || !envelope.to.length) {
      throw new Error('SMTP submission requires a sender and at least one recipient')
    }
    const raw = await mime.build()
    let sentCopy = raw
    if (!this.#credentials.smtpSavesSent && message.bcc.length) {
      mime.keepBcc = true
      sentCopy = await mime.build()
    }

    const smtp = this.#smtp(this.#credentials.smtp)
    let delivery: Awaited<ReturnType<Submission['sendMail']>>
    try {
      delivery = await smtp.sendMail({ raw, envelope: { from: envelope.from, to: envelope.to } })
    } catch (error) {
      // A transport failure can occur after DATA was accepted.
      throw smtpRejection(error) ?? new Error('SMTP submission failed or could not be confirmed')
    } finally {
      smtp.close()
    }
    if (!delivery.accepted.length) throw new SmtpRejection('SMTP did not accept any recipients')

    if (this.#credentials.smtpSavesSent) {
      return { ...delivery, messageId, sentCopy: 'server-managed' }
    }
    try {
      await this.appendSent(sentCopy)
      return { ...delivery, messageId, sentCopy: 'appended' }
    } catch {
      // SMTP already accepted the message. An APPEND failure must never trigger another send.
      return { ...delivery, messageId, sentCopy: 'failed' }
    }
  }

  async findSent(messageId: string): Promise<ImapMessageLocation | null> {
    return this.#withImap(async (client) => {
      const sent = mapFolders(await client.list()).find(
        (folder) => folder.label.providerId === 'SENT',
      )
      if (!sent) return null
      const mailbox = await client.mailboxOpen(sent.path, { readOnly: true })
      const matches = await client.search(
        { header: { 'Message-ID': `<${messageId}>` } },
        { uid: true },
      )
      if (!matches || matches.length === 0) return null
      // IMAP SEARCH HEADER is a substring match. Verify the envelope's exact Message-ID.
      for await (const item of client.fetch(matches.join(','), { envelope: true }, { uid: true })) {
        if (item.envelope?.messageId?.replace(/^<|>$/g, '') === messageId) {
          return { folder: sent.path, uidValidity: String(mailbox.uidValidity), uid: item.uid }
        }
      }
      return null
    }, SENT_LOOKUP_MS)
  }

  get draftEndpoint(): string {
    return imapEndpoint(this.#credentials.imap)
  }

  #draftId(folder: string, uid: number, uidValidity: bigint): string {
    return JSON.stringify({
      folder,
      uid,
      uidValidity: String(uidValidity),
      endpoint: this.draftEndpoint,
    })
  }

  listDrafts(): Promise<ImapDraftLocation[]> {
    return this.#withImap(async (client) => {
      const folder = mapFolders(await client.list()).find(
        (entry) => entry.label.providerId === 'DRAFT',
      )
      if (!folder) return []
      const box = await client.mailboxOpen(folder.path, { readOnly: true })
      if (!box.exists) return []
      const drafts: ImapDraftLocation[] = []
      for await (const item of client.fetch('1:*', { flags: true, size: true }, { uid: true })) {
        if (item.flags?.has('\\Deleted')) continue
        drafts.push({
          folder,
          uid: item.uid,
          uidValidity: String(box.uidValidity),
          size: item.size ?? 0,
          id: this.#draftId(folder.path, item.uid, box.uidValidity),
        })
      }
      return drafts
    })
  }

  readDraft(
    location: ImapDraftLocation,
  ): Promise<{ raw: Buffer; structure?: MessageStructureObject } | null> {
    return this.#withImap(async (client) => {
      const box = await client.mailboxOpen(location.folder.path, { readOnly: true })
      if (String(box.uidValidity) !== location.uidValidity) return null
      for await (const item of client.fetch(
        String(location.uid),
        { flags: true, source: true, bodyStructure: true },
        { uid: true },
      )) {
        if (item.uid === location.uid && item.source && !item.flags?.has('\\Deleted'))
          return { raw: item.source, structure: item.bodyStructure }
      }
      return null
    })
  }

  saveDraft(raw: string): Promise<{ id: string; message: { id: string }; sourceHash: string }> {
    return this.#withImap(async (client) => {
      const folder = mapFolders(await client.list()).find(
        (folder) => folder.label.providerId === 'DRAFT',
      )
      if (!folder) throw new Error('No IMAP Drafts folder')
      if (!this.#supportsUidExpunge(client))
        throw new Error('IMAP Draft replacement needs UID EXPUNGE')
      const source = Buffer.from(raw)
      const result = await client.append(folder.path, source, ['\\Draft', '\\Seen'])
      if (!result || !result.uid || !result.uidValidity)
        throw new Error('No UID for saved IMAP draft')
      const id = this.#draftId(folder.path, result.uid, result.uidValidity)
      return { id, message: { id }, sourceHash: draftSourceHash(source) }
    })
  }

  async deleteDraft(
    id: string,
    sourceHash: string | null,
    currentEndpoint: () => string | undefined = () => this.draftEndpoint,
  ): Promise<boolean> {
    const location = JSON.parse(id) as ImapMessageLocation & { endpoint?: string }
    if (
      !sourceHash ||
      location.endpoint !== this.draftEndpoint ||
      location.endpoint !== currentEndpoint()
    )
      return false
    return this.#withImap(async (client) => {
      if (!this.#supportsUidExpunge(client)) return false
      const mailbox = await client.mailboxOpen(location.folder)
      if (String(mailbox.uidValidity) !== location.uidValidity) return false
      let matches = false
      for await (const draft of client.fetch(
        String(location.uid),
        { flags: true, source: true },
        { uid: true },
      )) {
        matches =
          draft.uid === location.uid &&
          !!draft.source &&
          !draft.flags?.has('\\Deleted') &&
          draftSourceHash(draft.source) === sourceHash
      }
      if (!matches || location.endpoint !== currentEndpoint()) return false
      return (
        (await client.messageFlagsAdd(String(location.uid), ['\\Deleted'], { uid: true })) &&
        (await client.uidExpunge(location.uid))
      )
    })
  }

  #supportsUidExpunge(client: ImapClient): boolean {
    return (
      client.enabled.has('IMAP4REV2') ||
      client.capabilities.has('UIDPLUS') ||
      (client.capabilities.has('IMAP4rev2') && !client.capabilities.has('IMAP4rev1'))
    )
  }

  appendSent(raw: Buffer): Promise<void> {
    return this.#withImap(async (client) => {
      const sent = mapFolders(await client.list()).find(
        (folder) => folder.label.providerId === 'SENT',
      )
      if (!sent || !(await client.append(sent.path, raw, ['\\Seen']))) {
        throw new Error('Could not save the Sent copy')
      }
    })
  }

  setFlags(location: ImapMessageLocation, flags: string[]): Promise<boolean> {
    return this.#withMessage(location, (client) =>
      client.messageFlagsSet(String(location.uid), flags, { uid: true }),
    )
  }

  move(location: ImapMessageLocation, destination: string): Promise<boolean> {
    return this.#withMessage(location, async (client) => {
      const { native, available } = imapMoveSupport(client)
      if (native) return Boolean(await client.uidMove(location.uid, destination))
      if (!available) return false
      const uid = String(location.uid)
      const options = { uid: true }
      return Boolean(
        (await client.messageCopy(uid, destination, options)) &&
          (await client.messageFlagsAdd(uid, ['\\Deleted'], options)) &&
          (await client.uidExpunge(location.uid)),
      )
    })
  }

  #withMessage<T>(
    location: ImapMessageLocation,
    run: (client: ImapClient) => Promise<T>,
  ): Promise<T> {
    if (!Number.isInteger(location.uid) || location.uid < 1 || location.uid > 0xffff_ffff) {
      return Promise.reject(new Error('Invalid IMAP UID'))
    }
    return this.#withImap(async (client) => {
      const mailbox = await client.mailboxOpen(location.folder)
      if (String(mailbox.uidValidity) !== location.uidValidity) {
        throw new Error('The IMAP folder changed UIDVALIDITY')
      }
      return run(client)
    })
  }

  async #withImap<T>(run: (client: ImapClient) => Promise<T>, timeoutMs?: number): Promise<T> {
    const client = this.#imap(this.#credentials.imap)
    const operation = async () => {
      await connectImap(client)
      return run(client)
    }
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      if (timeoutMs === undefined) return await operation()
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('IMAP Sent lookup timed out')), timeoutMs)
      })
      return await Promise.race([operation(), timeout])
    } finally {
      clearTimeout(timer)
      client.close()
    }
  }
}
