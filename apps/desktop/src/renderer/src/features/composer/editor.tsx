import { COMPOSER_FIELD, composeStarterKit, INLINE_IMAGE_TYPES, InlineImage } from '@amc/composer'
import Collaboration from '@tiptap/extension-collaboration'
import {
  type Editor,
  EditorContent,
  type NodeViewProps,
  NodeViewWrapper,
  ReactNodeViewRenderer,
  useEditor,
  useEditorState,
} from '@tiptap/react'
import { Bold, Italic, List } from 'lucide-react'
import { memo, useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { getAmc } from '@/lib/amc'
import type { DraftSession } from './draft-session'

function InlinePreview({ draftId, src, alt }: { draftId: string; src: string; alt: string }) {
  const [url, setUrl] = useState('')
  useEffect(() => {
    let active = true
    setUrl('')
    if (src.startsWith('cid:')) {
      void getAmc()
        .composeImage(draftId, src.slice(4))
        .then(({ mimeType, content }) => {
          if (active && INLINE_IMAGE_TYPES.includes(mimeType))
            setUrl(`data:${mimeType};base64,${content}`)
        })
        .catch(() => {})
    }
    return () => {
      active = false
    }
  }, [draftId, src])
  return (
    <NodeViewWrapper as="span" contentEditable={false}>
      {url ? (
        <img src={url} alt={alt} className="my-2 max-h-72 max-w-full rounded" />
      ) : (
        <span className="text-muted-foreground">[{alt || 'Image'}]</span>
      )}
    </NodeViewWrapper>
  )
}

export function useComposerEditor({ id, doc }: DraftSession) {
  return useEditor({
    shouldRerenderOnTransaction: false,
    extensions: [
      composeStarterKit,
      InlineImage.extend({
        addNodeView() {
          return ReactNodeViewRenderer(({ node }: NodeViewProps) => (
            <InlinePreview draftId={id} src={node.attrs.src} alt={node.attrs.alt} />
          ))
        },
      }),
      Collaboration.configure({ document: doc, field: COMPOSER_FIELD }),
    ],
    editorProps: {
      attributes: {
        class: 'amc-compose-editor min-h-36 outline-none',
        'aria-label': 'Message body',
        role: 'textbox',
        'aria-multiline': 'true',
      },
    },
  })
}

export const ComposerToolbar = memo(function ComposerToolbar({
  editor,
}: {
  editor: Editor | null
}) {
  const formats = useEditorState({
    editor,
    selector: ({ editor }) => ({
      bold: editor?.isActive('bold'),
      italic: editor?.isActive('italic'),
      list: editor?.isActive('bulletList'),
    }),
  })

  return (
    <fieldset className="flex items-center gap-0.5 px-3 pt-2" aria-label="Formatting">
      <Button
        size="icon-sm"
        variant="ghost"
        aria-label="Bold"
        aria-pressed={Boolean(formats?.bold)}
        onClick={() => editor?.chain().focus().toggleBold().run()}
      >
        <Bold />
      </Button>
      <Button
        size="icon-sm"
        variant="ghost"
        aria-label="Italic"
        aria-pressed={Boolean(formats?.italic)}
        onClick={() => editor?.chain().focus().toggleItalic().run()}
      >
        <Italic />
      </Button>
      <Button
        size="icon-sm"
        variant="ghost"
        aria-label="Bullet list"
        aria-pressed={Boolean(formats?.list)}
        onClick={() => editor?.chain().focus().toggleBulletList().run()}
      >
        <List />
      </Button>
    </fieldset>
  )
})

export const ComposerEditor = memo(function ComposerEditor({
  editor,
  locked,
}: {
  editor: Editor | null
  locked: boolean
}) {
  return (
    <div inert={locked} className="px-5 py-3 text-sm leading-[1.65]">
      <EditorContent editor={editor} />
    </div>
  )
})
