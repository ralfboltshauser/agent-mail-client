import { randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { Readable } from 'node:stream'
import type { BlobStore } from '../../blobs.ts'
import {
  type BodyBlob,
  type BodyPart,
  type BodyParts,
  decodeBodyPart,
  readBodyParts,
} from '../../mail/body-blobs.ts'
import { collapseWhitespace, htmlToText } from '../../mail/text.ts'

export const BODY_SEARCH_LIMIT = 256 * 1024
// A Unicode character can occupy two UTF-16 code units. Keep one extra character to
// distinguish a complete body from a truncated prefix.
const SAMPLE_LIMIT = 2 * (BODY_SEARCH_LIMIT + 1)

function searchPrefix(text: string): string {
  return text.length <= BODY_SEARCH_LIMIT
    ? text
    : Array.from(text).slice(0, BODY_SEARCH_LIMIT).join('')
}

// Canonicalize CRLF like MailParser, including pairs split across chunks.
async function* utf8(source: Readable): AsyncGenerator<string> {
  let carry = ''
  for await (const chunk of source.setEncoding('utf8') as AsyncIterable<string>) {
    const text = carry + chunk
    carry = text.endsWith('\r') ? '\r' : ''
    yield text.slice(0, text.length - carry.length).replace(/\r\n/g, '\n')
  }
  if (carry) yield carry
}

function needsDecoding(part: BodyBlob) {
  return part.charset !== undefined || part.flowed !== undefined
}

/** MailParser selects and joins opaque references using its MIME and forwarded-header rules. */
export class ImapBodyParts {
  readonly #token = `\0${randomUUID()}:`
  readonly #parts: BodyBlob[] = []
  readonly #blobs: BlobStore

  constructor(blobs: BlobStore) {
    this.#blobs = blobs
  }

  async store(source: Readable, charset: string | undefined, flowed: boolean, delSp: boolean) {
    if (
      charset &&
      ['ascii', 'usascii', 'utf8'].includes(charset.toLowerCase().replace(/[^a-z0-9]/g, ''))
    ) {
      charset = undefined
    }
    // Some charset decoders and format=flowed need the entire part. Keep the transfer-decoded
    // bytes on disk and defer those conversions until display.
    const sourceBytes =
      charset || flowed ? source : Readable.from(utf8(source), { objectMode: false })
    const { hash, size } = await this.#blobs.putStream(sourceBytes)
    if (size === 0) return ''
    const index = this.#parts.push({ hash, charset, ...(flowed && { flowed: { delSp } }) }) - 1
    return `${this.#token}${index}\0`
  }

  #expand(body: string): BodyPart[] {
    return body.split(new RegExp(`${this.#token}(\\d+)\0`, 'g')).flatMap((piece, index) => {
      const part = index % 2 ? this.#parts[Number(piece)] : piece
      return part ? [part] : []
    })
  }

  async *#chunks(parts: BodyPart[], onSample?: () => void): AsyncGenerator<string> {
    for (const part of parts) {
      if (typeof part === 'string') {
        yield part
      } else if (needsDecoding(part)) {
        const chunks: Buffer[] = []
        let size = 0
        const limit = 2 * SAMPLE_LIMIT
        for await (const chunk of createReadStream(this.#blobs.path(part.hash), { end: limit })) {
          chunks.push(chunk)
          size += chunk.length
        }
        if (size > limit) onSample?.()
        yield decodeBodyPart(Buffer.concat(chunks, Math.min(size, limit)), part)
      } else {
        yield* createReadStream(this.#blobs.path(part.hash), { encoding: 'utf8' })
      }
    }
  }

  async #prefix(parts: BodyPart[], html: boolean) {
    let partial = false
    let prefix = ''
    let tail = ''
    for await (const chunk of this.#chunks(parts, () => {
      partial = true
    })) {
      let text = chunk
      if (!html) {
        // A whitespace run can cross chunks or MIME parts. Carry only its collapsed form.
        text = collapseWhitespace(tail + chunk)
        if (!prefix) text = text.trimStart()
        tail = text.match(/[ \n]{1,2}$/)?.[0] ?? ''
        text = text.slice(0, text.length - tail.length)
      }
      const remaining = SAMPLE_LIMIT - prefix.length
      prefix += text.slice(0, remaining)
      if (text.length > remaining) {
        partial = true
        break
      }
      // When a part needed a bounded charset or flowed sample, stop before later parts.
      if (partial) break
    }
    const full = html ? htmlToText(prefix) : prefix.trimEnd()
    const bodyText = searchPrefix(full)
    return { bodyText, partial: partial || bodyText !== full }
  }

  read(body: string | undefined): string | undefined {
    if (!body) return undefined
    const content = readBodyParts(this.#blobs, this.#expand(body))
    if (content === undefined) throw new Error('Missing IMAP body part')
    return content
  }

  async finish(text: string | undefined, html: string | false | undefined) {
    const htmlParts = this.#expand(html || '')
    const textParts = this.#expand(text ?? '')
    const plain = await this.#prefix(textParts, false)
    // A blank partial sample can still have text past the decoding limit.
    const textFromHtml = !plain.bodyText && !plain.partial && htmlParts.length > 0
    const { bodyText, partial } = textFromHtml ? await this.#prefix(htmlParts, true) : plain
    const bodyParts: BodyParts = {}
    if (!textFromHtml && textParts.length) bodyParts.text = textParts
    if (partial) {
      bodyParts.searchTruncated = true
      if (textFromHtml) bodyParts.textFromHtml = true
    }

    let bodyHtmlBlob: string | null = null
    const first = htmlParts[0]
    if (htmlParts.length === 1 && first && typeof first !== 'string' && !needsDecoding(first)) {
      bodyHtmlBlob = first.hash
      if (bodyParts.textFromHtml) bodyParts.html = htmlParts
    } else if (htmlParts.length) {
      bodyParts.html = htmlParts
    }
    return {
      bodyText,
      bodyHtmlBlob,
      bodyParts: Object.keys(bodyParts).length ? bodyParts : null,
    }
  }
}
