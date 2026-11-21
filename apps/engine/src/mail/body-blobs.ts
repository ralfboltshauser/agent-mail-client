import libmime from 'libmime'
import { decode } from 'libmime/lib/charset.js'
import type { BlobStore } from '../blobs.ts'
import { htmlToText, normalizeWhitespace } from './text.ts'

export interface BodyBlob {
  hash: string
  charset?: string
  flowed?: { delSp: boolean }
}

export type BodyPart = string | BodyBlob
export interface BodyParts {
  text?: BodyPart[]
  html?: BodyPart[]
  textFromHtml?: boolean
  searchTruncated?: boolean
}

export function decodeBodyPart(bytes: Buffer, part: BodyBlob): string {
  if (part.flowed) {
    // MailParser unfolds bytes before charset conversion.
    bytes = Buffer.from(libmime.decodeFlowed(bytes.toString('latin1'), part.flowed.delSp), 'latin1')
  }
  const text = part.charset ? decode(bytes, part.charset) : bytes.toString('utf8')
  return text.replace(/\r\n/g, '\n')
}

export function readBodyParts(blobs: BlobStore, parts: BodyPart[]): string | undefined {
  const text: string[] = []
  for (const part of parts) {
    if (typeof part === 'string') {
      text.push(part)
    } else {
      const bytes = blobs.get(part.hash)
      if (!bytes) return undefined
      text.push(decodeBodyPart(bytes, part))
    }
  }
  return text.join('')
}

export function readTextBody(blobs: BlobStore, body: BodyParts): string | undefined {
  if (!body.searchTruncated) return
  const parts = body.textFromHtml ? body.html : body.text
  const text = parts && readBodyParts(blobs, parts)
  if (text === undefined) return
  return body.textFromHtml ? htmlToText(text) : normalizeWhitespace(text)
}
