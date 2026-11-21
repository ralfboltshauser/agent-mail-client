import { COMPOSER_FIELD, composeStarterKit, InlineImage } from '@amc/composer'
import { generateText, getSchema, type JSONContent } from '@tiptap/core'
import { generateHTML, generateJSON } from '@tiptap/html/server'
import { prosemirrorJSONToYDoc, yDocToProsemirrorJSON } from '@tiptap/y-tiptap'
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

export function renderDraft(doc: Y.Doc): { text: string; html: string } {
  const json = yDocToProsemirrorJSON(doc, field)
  schema.nodeFromJSON(json).check()
  return { text: generateText(json, extensions), html: generateHTML(json, extensions) }
}
