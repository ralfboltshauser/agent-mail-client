import { COMPOSER_FIELD, composeStarterKit, InlineImage } from '@amc/composer'
import { generateText, getSchema, type JSONContent } from '@tiptap/core'
import { generateHTML, generateJSON } from '@tiptap/html/server'
import { prosemirrorJSONToYDoc, updateYFragment, yDocToProsemirrorJSON } from '@tiptap/y-tiptap'
import * as Y from 'yjs'

const extensions = [composeStarterKit, InlineImage]
const schema = getSchema(extensions)
const field = COMPOSER_FIELD

function paragraphs(text: string): JSONContent[] {
  return text.split('\n').map((line) => ({
    type: 'paragraph',
    ...(line ? { content: [{ type: 'text', text: line }] } : {}),
  }))
}

export function draftDocument(saved: Uint8Array | null, text: string): Y.Doc {
  if (!saved)
    return prosemirrorJSONToYDoc(schema, { type: 'doc', content: paragraphs(text) }, field)
  const doc = new Y.Doc()
  Y.applyUpdate(doc, saved)
  return doc
}

export function replaceDraftContent(doc: Y.Doc, text: string, html?: string | null): void {
  if (html) {
    const imported = prosemirrorJSONToYDoc(schema, generateJSON(html, extensions), field)
    const target = doc.getXmlFragment(field)
    const nodes = imported
      .getXmlFragment(field)
      .toArray()
      .flatMap((node) =>
        node instanceof Y.XmlElement || node instanceof Y.XmlText ? [node.clone()] : [],
      )
    doc.transact(() => {
      target.delete(0, target.length)
      target.insert(0, nodes)
    })
    return
  }
  const target = doc.getXmlFragment(field)
  const nodes = paragraphs(text).map((paragraph) => {
    const node = new Y.XmlElement('paragraph')
    const line = paragraph.content?.[0]?.text
    if (line) {
      const text = new Y.XmlText()
      text.insert(0, line)
      node.insert(0, [text])
    }
    return node
  })
  doc.transact(() => {
    target.delete(0, target.length)
    target.insert(0, nodes)
  })
}

export function editDraftText(doc: Y.Doc, text: string): void {
  const target = schema.nodeFromJSON({ type: 'doc', content: paragraphs(text) })
  updateYFragment(doc, doc.getXmlFragment(field), target, {
    mapping: new Map(),
    isOMark: new Map(),
  })
}

export function renderDraft(doc: Y.Doc, blockSeparator?: string): { text: string; html: string } {
  const json = yDocToProsemirrorJSON(doc, field)
  schema.nodeFromJSON(json).check()
  return {
    text: generateText(json, extensions, { blockSeparator }),
    html: generateHTML(json, extensions),
  }
}

export function applyDraftUpdate(doc: Y.Doc, update: Uint8Array): boolean {
  const { structs, ds } = Y.decodeUpdate(update)
  const changes = structs.flatMap((item) => {
    if (!(item instanceof Y.Item) || !(item.content instanceof Y.ContentString)) return []
    const start = Math.max(item.id.clock, Y.getState(doc.store, item.id.client))
    const end = item.id.clock + item.length
    return start < end ? [{ client: item.id.client, start, end }] : []
  })
  Y.applyUpdate(doc, update)
  if (doc.store.pendingStructs || doc.store.pendingDs) throw new Error('Missing Yjs dependencies')
  // If a concurrent edit removed an enclosing block, Yjs can silently discard new text.
  // Distinguish those insertions from text the incoming update also intentionally deleted.
  for (const { client, start, end } of changes) {
    for (let clock = start; clock < end; ) {
      const id = Y.createID(client, clock)
      const item = Y.getItem(doc.store, id)
      const next = Math.min(end, item.id.clock + item.length)
      if (
        item.deleted &&
        !ds.clients
          .get(client)
          ?.some((range) => range.clock <= clock && range.clock + range.len >= next)
      )
        return false
      clock = next
    }
  }
  return true
}
