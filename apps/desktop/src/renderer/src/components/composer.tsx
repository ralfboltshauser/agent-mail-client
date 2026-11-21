import {
  COMPOSER_FIELD,
  composeStarterKit,
  INLINE_IMAGE_NAME,
  INLINE_IMAGE_TYPES,
  InlineImage,
} from '@amc/composer'
import type {
  AccountSummary,
  ComposeAttachment,
  ComposeDraft,
  ComposeFields,
  ComposePatch,
  OutboxItem,
  SendRequest,
} from '@amc/protocol'
import { DRAFT_CHANGED, MIRROR_CHANGED } from '@amc/protocol'
import Collaboration from '@tiptap/extension-collaboration'
import {
  EditorContent,
  type NodeViewProps,
  NodeViewWrapper,
  ReactNodeViewRenderer,
  useEditor,
  useEditorState,
} from '@tiptap/react'
import { Bold, Italic, List, Minus, Paperclip, X } from 'lucide-react'
import { useCallback, useEffect, useId, useRef, useState } from 'react'
import * as Y from 'yjs'
import { RecipientField } from './recipient-field'
import { Button } from './ui/button'
import { Dialog, DialogContent, DialogTitle } from './ui/dialog'
import { Input } from './ui/input'
import { Kbd } from './ui/kbd'

function base64(bytes: Uint8Array) {
  let binary = ''
  for (let offset = 0; offset < bytes.length; offset += 8192) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192))
  }
  return btoa(binary)
}

const remote = Symbol('engine')
function headerFields(draft: ComposeDraft): ComposeFields {
  return {
    accountId: draft.accountId,
    to: draft.to,
    cc: draft.cc,
    bcc: draft.bcc,
    subject: draft.subject,
    attachmentIds: draft.attachments.map((part) => part.id),
  }
}

function InlinePreview({ draftId, src, alt }: { draftId: string; src: string; alt: string }) {
  const [url, setUrl] = useState('')
  useEffect(() => {
    let active = true
    setUrl('')
    if (src.startsWith('cid:')) {
      void window.amc
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

function apply(doc: Y.Doc, update: string) {
  Y.applyUpdate(
    doc,
    Uint8Array.from(atob(update), (ch) => ch.charCodeAt(0)),
    remote,
  )
}

export function Composer({
  draft,
  accounts,
  onMinimise,
  onQueued,
}: {
  draft: ComposeDraft
  accounts: AccountSummary[]
  onMinimise: (subject: string) => void
  onQueued: (item: OutboxItem) => void
}) {
  const [doc] = useState(() => {
    const value = new Y.Doc()
    apply(value, draft.update)
    return value
  })
  const [fields, setFields] = useState(() => headerFields(draft))
  const fieldsRef = useRef(fields)
  const baseline = useRef(draft)
  const [reviewedRevision, setReviewedRevision] = useState(draft.revision)
  const [draftSignature, setDraftSignature] = useState(draft.signature)
  const [quote, setQuote] = useState(draft.quote)
  const [attachments, setAttachments] = useState(draft.attachments)
  const attachmentsRef = useRef(attachments)

  const [expanded, setExpanded] = useState(Boolean(draft.cc.length || draft.bcc.length))
  const [version, setVersion] = useState(0)
  const versionRef = useRef(0)
  const savedRef = useRef(0)
  const [saved, setSaved] = useState(0)
  const [busy, setBusy] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [conflict, setConflict] = useState(false)
  const [error, setError] = useState('')
  const [mirrorError, setMirrorError] = useState(draft.mirrorError)
  const [mirrorConflict, setMirrorConflict] = useState(draft.mirrorConflict)
  const [schedule, setSchedule] = useState(false)
  const [sendAt, setSendAt] = useState('')
  const [signature, setSignature] = useState<string | null>(null)
  const subjectId = useId()
  const surface = useRef<HTMLDivElement>(null)
  const fileInput = useRef<HTMLInputElement>(null)
  const saveChain = useRef<Promise<unknown>>(Promise.resolve())
  const request = useRef<SendRequest | null>(null)
  const submitting = useRef(false)
  const uploadInFlight = useRef(false)
  const editor = useEditor({
    extensions: [
      composeStarterKit,
      InlineImage.extend({
        addNodeView() {
          return ReactNodeViewRenderer(({ node }: NodeViewProps) => (
            <InlinePreview draftId={draft.id} src={node.attrs.src} alt={node.attrs.alt} />
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
  const formats = useEditorState({
    editor,
    selector: ({ editor }) => ({
      bold: editor?.isActive('bold'),
      italic: editor?.isActive('italic'),
      list: editor?.isActive('bulletList'),
    }),
  })

  const changed = useCallback(() => {
    versionRef.current++
    setVersion(versionRef.current)
  }, [])
  const updateField = <K extends keyof typeof fields>(key: K, value: (typeof fields)[K]) => {
    fieldsRef.current = { ...fieldsRef.current, [key]: value }
    setFields(fieldsRef.current)
    changed()
  }

  const adopt = useCallback((next: ComposeDraft) => {
    baseline.current = next
    setReviewedRevision(next.revision)
    fieldsRef.current = headerFields(next)
    attachmentsRef.current = next.attachments
    setFields(fieldsRef.current)
    setAttachments(next.attachments)
    setDraftSignature(next.signature)
    setQuote(next.quote)
    if (next.cc.length || next.bcc.length) setExpanded(true)
  }, [])

  useEffect(() => {
    const onUpdate = (_update: Uint8Array, origin: unknown) => {
      if (origin === remote) return
      try {
        window.amc.stageComposeBody(draft.id, {
          baseRevision: baseline.current.revision,
          update: base64(Y.encodeStateAsUpdate(doc)),
        })
      } catch (cause) {
        setError((cause as Error).message)
      }
      changed()
    }
    doc.on('update', onUpdate)
    let running = false
    let mounted = true
    const timer = window.setInterval(() => {
      if (running || submitting.current || request.current) return
      running = true
      void window.amc
        .composeDraft(draft.id)
        .then((next) => {
          if (!mounted || next.revision < baseline.current.revision || submitting.current) return
          apply(doc, next.update)
          setMirrorError(next.mirrorError)
          setMirrorConflict(next.mirrorConflict)
          if (versionRef.current === savedRef.current && !uploadInFlight.current) adopt(next)
        })
        .catch(() => {})
        .finally(() => {
          running = false
        })
    }, 1500)
    return () => {
      mounted = false
      window.clearInterval(timer)
      doc.off('update', onUpdate)
    }
  }, [doc, draft.id, adopt, changed])

  const edits = (revision: number): ComposePatch => {
    const current = {
      ...fieldsRef.current,
      attachmentIds: attachmentsRef.current.map((part) => part.id),
    }
    return {
      baseRevision: revision,
      update: base64(Y.encodeStateAsUpdate(doc)),
      fields:
        JSON.stringify(current) !== JSON.stringify(headerFields(baseline.current))
          ? current
          : undefined,
    }
  }

  const save = () => {
    const pending = saveChain.current
      .catch(() => {})
      .then(async () => {
        const started = versionRef.current
        const before = baseline.current
        const updated = await window.amc.saveCompose(draft.id, edits(before.revision))
        apply(doc, updated.update)
        baseline.current = updated
        if (versionRef.current === started) adopt(updated)
        savedRef.current = started
        setSaved(started)
        return updated
      })
    saveChain.current = pending
    return pending
  }

  const saveError = (cause: unknown) => {
    const message = (cause as Error).message
    setConflict(message.includes('may have changed'))
    setError(message)
  }

  useEffect(() => {
    if (version === saved || busy || request.current || conflict) return
    const timer = window.setTimeout(() => {
      void save().catch(saveError)
    }, 550)
    return () => window.clearTimeout(timer)
  })

  const upload = async (files: File[], paste = false) => {
    if (!files.length || submitting.current || request.current || uploadInFlight.current) return
    setError('')
    setUploading(true)
    uploadInFlight.current = true
    const available =
      18 * 1024 * 1024 - attachmentsRef.current.reduce((sum, part) => sum + part.size, 0)
    try {
      if (files.reduce((sum, file) => sum + file.size, 0) > available)
        throw new Error('Attachments must total 18 MB or less.')
      for (const file of files) {
        const inline = paste && INLINE_IMAGE_TYPES.includes(file.type)
        const part = await window.amc.addComposeAttachment(
          draft.id,
          file.name || 'attachment',
          file.type || 'application/octet-stream',
          new Uint8Array(await file.arrayBuffer()),
          inline,
        )
        if (part.contentId) {
          editor
            ?.chain()
            .focus()
            .insertContent({
              type: INLINE_IMAGE_NAME,
              attrs: { src: `cid:${part.contentId}`, alt: part.filename },
            })
            .run()
        }
        attachmentsRef.current = [...attachmentsRef.current, part]
        setAttachments(attachmentsRef.current)
        changed()
      }
    } catch (cause) {
      setError((cause as Error).message)
    } finally {
      uploadInFlight.current = false
      setUploading(false)
    }
  }

  const minimise = async () => {
    if (submitting.current || uploadInFlight.current) return
    submitting.current = true
    setBusy(true)
    try {
      if (versionRef.current !== savedRef.current && !request.current) await save()
      onMinimise(fieldsRef.current.subject)
    } catch (cause) {
      saveError(cause)
    } finally {
      submitting.current = false
      setBusy(false)
    }
  }

  const send = async () => {
    if (!editor || submitting.current || uploadInFlight.current) return
    const pendingRecipient = [
      ...(surface.current?.querySelectorAll<HTMLInputElement>('[data-recipient-input]') ?? []),
    ].find((input) => input.value.trim())
    if (!request.current && pendingRecipient) {
      setError('Press Return to add the address before sending.')
      pendingRecipient.focus()
      return
    }
    if (!request.current && ![...fields.to, ...fields.cc, ...fields.bcc].length) {
      setError('Add a recipient before sending.')
      return
    }
    if (!request.current && schedule && (!sendAt || new Date(sendAt).getTime() <= Date.now())) {
      setError('Choose a send time in the future.')
      return
    }
    submitting.current = true
    setBusy(true)
    setError('')
    try {
      if (!request.current) {
        const { update, fields: pendingFields } = edits(reviewedRevision)
        request.current = {
          id: crypto.randomUUID(),
          draftId: draft.id,
          revision: reviewedRevision,
          ...(versionRef.current !== savedRef.current
            ? { edits: { update, fields: pendingFields } }
            : {}),
          ...(schedule ? { sendAt: new Date(sendAt).getTime() } : {}),
        }
      }
      const item = await window.amc.sendDraft(request.current)
      onQueued(item)
    } catch (cause) {
      const message = (cause as Error).message
      if (message.includes(DRAFT_CHANGED)) {
        request.current = null
        setError(DRAFT_CHANGED)
        setConflict(true)
        try {
          const next = await window.amc.composeDraft(draft.id)
          apply(doc, next.update)
          adopt(next)
          setConflict(false)
        } catch {
          // Keep the review message and allow a manual reload.
        }
      } else if (message.includes(MIRROR_CHANGED)) {
        request.current = null
        setError(MIRROR_CHANGED)
      } else if (request.current) {
        setError(`${message} Check the Outbox or confirm this send again.`)
      } else saveError(cause)
    } finally {
      submitting.current = false
      setBusy(false)
    }
  }

  const locked = busy || Boolean(request.current)

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) void minimise()
      }}
    >
      <DialogContent
        ref={surface}
        showCloseButton={false}
        aria-describedby={undefined}
        className="flex max-h-[90dvh] max-w-[calc(100%-2rem)] flex-col gap-0 overflow-hidden p-0 sm:max-w-2xl"
        onPointerDownOutside={(event) => event.preventDefault()}
        onKeyDown={(event) => {
          if (!event.nativeEvent.isComposing && event.metaKey && event.key === 'Enter') {
            event.preventDefault()
            event.stopPropagation()
            void send()
          }
        }}
      >
        <header className="flex shrink-0 items-center justify-between gap-3 border-b px-4 py-3">
          <DialogTitle className="text-sm">Compose</DialogTitle>
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label="Minimise and save draft"
            disabled={busy || uploading}
            onClick={() => void minimise()}
          >
            <Minus />
          </Button>
        </header>
        <section
          aria-label="Message"
          className="min-h-0 overflow-auto"
          onDragOver={(event) => event.preventDefault()}
          onDrop={(event) => {
            event.preventDefault()
            void upload(Array.from(event.dataTransfer.files))
          }}
          onPasteCapture={(event) => {
            const files = Array.from(event.clipboardData.files)
            if (files.length) {
              event.preventDefault()
              void upload(files, true)
            }
          }}
        >
          <fieldset disabled={locked} className="min-w-0">
            <label className="grid grid-cols-[3rem_1fr] items-center border-b px-4 py-1.5 text-sm text-muted-foreground">
              From
              <select
                className="h-8 w-full rounded bg-background px-2 text-foreground focus-visible:outline-ring"
                value={fields.accountId}
                onChange={(event) => {
                  updateField('accountId', event.target.value)
                  setSignature(null)
                }}
              >
                {accounts.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.address}
                  </option>
                ))}
              </select>
            </label>
            <div className="relative">
              <RecipientField
                label="To"
                recipients={fields.to}
                onChange={(values) => updateField('to', values)}
              />
              {!expanded && (
                <Button
                  className="absolute top-1.5 right-3"
                  variant="secondary"
                  size="xs"
                  onClick={() => setExpanded(true)}
                >
                  Cc / Bcc
                </Button>
              )}
            </div>
            {expanded && (
              <>
                <RecipientField
                  label="Cc"
                  recipients={fields.cc}
                  onChange={(values) => updateField('cc', values)}
                />
                <RecipientField
                  label="Bcc"
                  recipients={fields.bcc}
                  onChange={(values) => updateField('bcc', values)}
                />
              </>
            )}
            <label
              htmlFor={subjectId}
              className="grid grid-cols-[3rem_1fr] items-center border-b px-4 py-1.5 text-sm text-muted-foreground"
            >
              Subject
              <Input
                id={subjectId}
                value={fields.subject}
                onChange={(event) => updateField('subject', event.target.value)}
                className="h-8 border-0 bg-transparent text-foreground shadow-none dark:bg-transparent"
                maxLength={998}
              />
            </label>
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
            <div inert={locked} className="px-4 py-2 text-sm leading-relaxed">
              <EditorContent editor={editor} />
            </div>
            {draftSignature && (
              <p className="mx-4 mb-3 whitespace-pre-wrap text-sm text-muted-foreground">
                {draftSignature}
              </p>
            )}
            {quote && (
              <details className="mx-4 mb-3 rounded-md bg-muted/50 p-2 text-xs text-muted-foreground">
                <summary className="cursor-pointer">Quoted message</summary>
                <pre className="mt-2 max-h-36 overflow-auto whitespace-pre-wrap font-sans">
                  {quote}
                </pre>
              </details>
            )}
            {attachments.length > 0 && (
              <ul className="mx-4 mb-3 flex flex-wrap gap-1.5">
                {attachments.map((part: ComposeAttachment) => (
                  <li
                    key={part.id}
                    className="flex max-w-full items-center gap-1 rounded-md bg-muted pl-2 text-xs"
                  >
                    <span className="truncate">{part.filename}</span>
                    <Button
                      size="icon-xs"
                      variant="ghost"
                      aria-label={`Remove ${part.filename}`}
                      onClick={() => {
                        attachmentsRef.current = attachmentsRef.current.filter(
                          (item) => item.id !== part.id,
                        )
                        setAttachments(attachmentsRef.current)
                        if (part.contentId && editor) {
                          const tr = editor.state.tr
                          editor.state.doc.descendants((node, pos) => {
                            if (
                              node.type.name === INLINE_IMAGE_NAME &&
                              node.attrs.src === `cid:${part.contentId}`
                            ) {
                              tr.delete(tr.mapping.map(pos), tr.mapping.map(pos + node.nodeSize))
                            }
                          })
                          if (tr.docChanged) editor.view.dispatch(tr)
                        }
                        changed()
                      }}
                    >
                      <X />
                    </Button>
                  </li>
                ))}
              </ul>
            )}
            {signature !== null && (
              <label className="mx-4 mb-3 flex flex-col gap-1 text-xs">
                Signature for this Account
                <textarea
                  className="min-h-16 rounded-md border bg-background p-2"
                  value={signature}
                  maxLength={5000}
                  onChange={(event) => setSignature(event.target.value)}
                />
                <div className="flex gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => {
                      void window.amc
                        .saveSignature(fields.accountId, signature)
                        .then(() => setSignature(null))
                        .catch((cause: Error) => setError(cause.message))
                    }}
                  >
                    Save for future drafts
                  </Button>
                </div>
              </label>
            )}
          </fieldset>
        </section>
        {error && (
          <p role="alert" className="border-t px-4 py-2 text-sm text-destructive">
            {error}
          </p>
        )}
        {conflict && (
          <div className="px-4 pb-2">
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                void window.amc
                  .composeDraft(draft.id)
                  .then((next) => {
                    apply(doc, next.update)
                    adopt(next)
                    setConflict(false)
                    setError('')
                    changed()
                  })
                  .catch(saveError)
              }}
            >
              Reload message details
            </Button>
          </div>
        )}
        {mirrorConflict && (
          <output className="border-t px-4 py-2 text-xs text-muted-foreground">
            The Account’s draft changed. Your local copy was kept.
          </output>
        )}
        {mirrorError && !error && (
          <output className="border-t px-4 py-2 text-xs text-muted-foreground">
            Saved in AMC. Waiting to sync to the Account’s Drafts.
          </output>
        )}
        <footer className="flex shrink-0 flex-wrap items-center gap-2 border-t px-4 py-3">
          <Button size="sm" onClick={() => void send()} disabled={busy || uploading || !editor}>
            {request.current ? 'Confirm send' : schedule ? 'Schedule send' : 'Send'} <Kbd>⌘↵</Kbd>
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={locked}
            onClick={() => setSchedule(!schedule)}
          >
            {schedule ? 'Send now' : 'Send later'}
          </Button>
          {schedule && (
            <Input
              aria-label="Send date and time"
              type="datetime-local"
              className="h-8 w-auto"
              value={sendAt}
              disabled={locked}
              onChange={(event) => setSendAt(event.target.value)}
            />
          )}
          <div className="ml-auto flex gap-1">
            <Button
              variant="ghost"
              size="sm"
              disabled={locked}
              onClick={() => {
                if (signature !== null) setSignature(null)
                else
                  void window.amc
                    .signature(fields.accountId)
                    .then(({ signature }) => setSignature(signature))
                    .catch((cause: Error) => setError(cause.message))
              }}
            >
              Signature
            </Button>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Add attachments"
              disabled={locked || uploading}
              onClick={() => fileInput.current?.click()}
            >
              <Paperclip />
            </Button>
            <input
              ref={fileInput}
              className="hidden"
              type="file"
              multiple
              onChange={(event) => {
                void upload(Array.from(event.target.files ?? []))
                event.target.value = ''
              }}
            />
          </div>
        </footer>
      </DialogContent>
    </Dialog>
  )
}
