import { Node } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'

export const COMPOSER_FIELD = 'default'
export const INLINE_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp']
export const INLINE_IMAGE_NAME = 'inlineImage'

export const InlineImage = Node.create({
  name: INLINE_IMAGE_NAME,
  inline: true,
  group: 'inline',
  atom: true,
  addAttributes() {
    return { src: { default: '' }, alt: { default: '' } }
  },
  parseHTML() {
    return [{ tag: 'img[src^="cid:"]' }]
  },
  renderHTML({ node }) {
    const src = /^cid:[\w.!%+@-]+$/i.test(node.attrs.src) ? node.attrs.src : undefined
    return ['img', { src, alt: node.attrs.alt }]
  },
  renderText({ node }) {
    return node.attrs.alt ? `[Image: ${node.attrs.alt}]` : '[Image]'
  },
})

export const composeStarterKit = StarterKit.configure({
  undoRedo: false,
  link: { openOnClick: false },
})
