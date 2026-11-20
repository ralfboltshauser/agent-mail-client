import { randomBytes } from 'node:crypto'
import type { Address } from '@amc/protocol'

export interface OutgoingMessage {
  from: Address
  to: Address[]
  cc: Address[]
  bcc: Address[]
  subject: string
  text: string
  inReplyTo?: string | null
  references?: string | null
  messageId?: string
  date?: Date
}

/** RFC 2047 encoded-word for header text that is not plain ASCII. */
export function encodeHeaderText(text: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: checking for plain ASCII on purpose
  if (/^[\x20-\x7e]*$/.test(text)) return text
  // Split into chunks so each encoded word stays under 75 characters.
  const words: string[] = []
  let chunk = ''
  for (const ch of text) {
    if (Buffer.byteLength(chunk + ch) > 45) {
      words.push(chunk)
      chunk = ''
    }
    chunk += ch
  }
  if (chunk) words.push(chunk)
  return words.map((w) => `=?UTF-8?B?${Buffer.from(w).toString('base64')}?=`).join('\r\n ')
}

export function formatAddress(a: Address): string {
  if (!a.name) return a.address
  // biome-ignore lint/suspicious/noControlCharactersInRegex: checking for plain ASCII on purpose
  const ascii = /^[\x20-\x7e]*$/.test(a.name)
  const name = ascii
    ? /^[A-Za-z0-9!#$%&'*+\-/=?^_`{|}~ ]+$/.test(a.name)
      ? a.name
      : `"${a.name.replace(/(["\\])/g, '\\$1')}"`
    : encodeHeaderText(a.name)
  return `${name} <${a.address}>`
}

export function newMessageId(fromAddress: string): string {
  const domain = fromAddress.split('@')[1] || 'amc.local'
  return `amc.${Date.now().toString(36)}.${randomBytes(8).toString('hex')}@${domain}`
}

/** Builds an RFC 5322 message with a UTF-8 text body (base64, CRLF line endings). */
export function buildMessage(msg: OutgoingMessage): string {
  const headers: string[] = [
    `From: ${formatAddress(msg.from)}`,
    ...(msg.to.length ? [`To: ${msg.to.map(formatAddress).join(', ')}`] : []),
    ...(msg.cc.length ? [`Cc: ${msg.cc.map(formatAddress).join(', ')}`] : []),
    ...(msg.bcc.length ? [`Bcc: ${msg.bcc.map(formatAddress).join(', ')}`] : []),
    `Subject: ${encodeHeaderText(msg.subject)}`,
    `Date: ${(msg.date ?? new Date()).toUTCString().replace('GMT', '+0000')}`,
    `Message-ID: <${msg.messageId ?? newMessageId(msg.from.address)}>`,
    ...(msg.inReplyTo ? [`In-Reply-To: <${msg.inReplyTo}>`] : []),
    ...(msg.references ? [`References: ${msg.references}`] : []),
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: base64',
  ]
  const body = Buffer.from(msg.text.replace(/\r?\n/g, '\r\n'), 'utf8')
    .toString('base64')
    .replace(/.{1,76}/g, '$&\r\n')
  return `${headers.join('\r\n')}\r\n\r\n${body}`
}

/** "Re: " once, the way mail clients do it. */
export function replySubject(subject: string): string {
  return /^\s*re\s*:/i.test(subject) ? subject.trim() : `Re: ${subject.trim()}`
}
