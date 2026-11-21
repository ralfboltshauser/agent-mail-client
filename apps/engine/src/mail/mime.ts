import { randomBytes } from 'node:crypto'
import type { Address } from '@amc/protocol'
import MailComposer from 'nodemailer/lib/mail-composer'

export interface OutgoingMessage {
  from: Address
  to: Address[]
  cc: Address[]
  bcc: Address[]
  subject: string
  text: string
  html?: string
  attachments?: { filename: string; mimeType: string; content: string; contentId?: string }[]
  inReplyTo?: string | null
  references?: string | null
  messageId?: string
  date?: Date
}

export function newMessageId(fromAddress: string): string {
  const domain = fromAddress.split('@')[1] || 'amc.local'
  return `amc.${Date.now().toString(36)}.${randomBytes(8).toString('hex')}@${domain}`
}

/** Uses an explicit envelope at SMTP submission and retains Bcc in saved copies. */
export function compileMessage(message: OutgoingMessage) {
  const address = (value: Address) => ({ address: value.address, name: value.name ?? '' })
  return new MailComposer({
    from: address(message.from),
    to: message.to.map(address),
    cc: message.cc.map(address),
    bcc: message.bcc.map(address),
    subject: message.subject,
    text: message.text,
    html: message.html,
    messageId: message.messageId ?? newMessageId(message.from.address),
    date: message.date ?? new Date(),
    inReplyTo: message.inReplyTo ?? undefined,
    references: message.references ?? undefined,
    attachments: message.attachments?.map((attachment) => ({
      filename: attachment.filename,
      contentType: attachment.mimeType,
      content: Buffer.from(attachment.content, 'base64'),
      cid: attachment.contentId,
    })),
    disableFileAccess: true,
    disableUrlAccess: true,
  }).compile()
}

export async function buildMessage(message: OutgoingMessage): Promise<string> {
  const mime = compileMessage(message)
  mime.keepBcc = true
  return (await mime.build()).toString('utf8')
}

/** "Re: " once, the way mail clients do it. */
export function replySubject(subject: string): string {
  return /^\s*re\s*:/i.test(subject) ? subject.trim() : `Re: ${subject.trim()}`
}
