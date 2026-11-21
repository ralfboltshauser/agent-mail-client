import type { Address } from '@amc/protocol'
import MailComposer from 'nodemailer/lib/mail-composer'
import { newMessageId, type OutgoingMessage } from '../../mail/mime.ts'
import {
  connectImap,
  createImapClient,
  createSmtpClient,
  type ImapClient,
  type ImapClientFactory,
  type ImapCredentials,
} from './client.ts'
import { mapFolders } from './mapping.ts'

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
    const address = (a: Address) => ({ address: a.address, name: a.name ?? '' })
    const mime = new MailComposer({
      from: address(message.from),
      to: message.to.map(address),
      cc: message.cc.map(address),
      bcc: message.bcc.map(address),
      subject: message.subject,
      text: message.text,
      messageId,
      date: message.date ?? new Date(),
      inReplyTo: message.inReplyTo ?? undefined,
      references: message.references ?? undefined,
      disableFileAccess: true,
      disableUrlAccess: true,
    }).compile()
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
    } catch {
      // Failures around DATA can be ambiguous, so callers must decide whether to retry.
      throw new Error('SMTP submission failed or could not be confirmed')
    } finally {
      smtp.close()
    }
    if (!delivery.accepted.length) throw new Error('SMTP did not accept any recipients')

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
      const rev2 =
        client.enabled.has('IMAP4REV2') ||
        (client.capabilities.has('IMAP4rev2') && !client.capabilities.has('IMAP4rev1'))
      if (!rev2 && !client.capabilities.has('MOVE') && !client.capabilities.has('UIDPLUS')) {
        // ImapFlow's fallback would issue a mailbox-wide EXPUNGE.
        return false
      }
      return Boolean(await client.messageMove(String(location.uid), destination, { uid: true }))
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

  async #withImap<T>(run: (client: ImapClient) => Promise<T>): Promise<T> {
    const client = this.#imap(this.#credentials.imap)
    try {
      await connectImap(client)
      return await run(client)
    } finally {
      client.close()
    }
  }
}
