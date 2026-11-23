import { INLINE_IMAGE_NAME, INLINE_IMAGE_TYPES } from '@amc/composer'
import {
  type ComposeAttachment,
  type ComposeDraft,
  DRAFT_CHANGED,
  MIRROR_CHANGED,
  type OutboxItem,
  type SendRequest,
} from '@amc/protocol'
import type { Editor } from '@tiptap/react'
import { useCallback, useEffect, useEffectEvent, useRef, useState } from 'react'
import { getAmc } from '@/lib/amc'
import { failureText, recordCaughtFailure } from '@/lib/failure'
import { DraftSession } from './draft-session'

type DraftReview = { subject: string; revision: number }

export function useComposerSession(draft: ComposeDraft, onDiscarded: (dirty: boolean) => void) {
  const [session] = useState(() => new DraftSession(draft, getAmc))
  const [busy, setBusy] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [confirmDiscard, setConfirmDiscard] = useState<DraftReview | null>(null)
  const [confirmSend, setConfirmSend] = useState(false)
  const [conflict, setConflict] = useState(false)
  const [error, setError] = useState('')
  const replacementId = useRef<string | undefined>(undefined)
  const submitting = useRef(false)
  const uploadInFlight = useRef(false)
  const discardReview = useRef<DraftReview | null>(null)
  const request = useRef<SendRequest | null>(null)
  const blockedByConflict = useRef(false)

  const syncAutosave = useCallback(() => {
    session.pauseAutosave(
      Boolean(
        submitting.current || discardReview.current || request.current || blockedByConflict.current,
      ),
    )
  }, [session])

  const reportError = useCallback((cause: unknown) => {
    setError(failureText(cause))
  }, [])

  const showConflict = useCallback(
    (value: boolean) => {
      blockedByConflict.current = value
      setConflict(value)
      syncAutosave()
    },
    [syncAutosave],
  )

  const saveError = useCallback(
    (cause: unknown) => {
      const message = (cause as Error).message
      showConflict(message.includes('may have changed'))
      setError(
        message.includes('may have changed')
          ? `Reopen the draft to review its fields. ${failureText(cause)}`
          : failureText(cause),
      )
    },
    [showConflict],
  )

  const draftDiscarded = useEffectEvent(() => {
    discardReview.current = null
    setConfirmDiscard(null)
    setError('')
    onDiscarded(session.dirty)
  })

  // biome-ignore lint/correctness/useExhaustiveDependencies: React Effect Events are intentionally excluded from effect dependencies.
  useEffect(
    () =>
      session.connect({
        onStageError: reportError,
        onSaveError: saveError,
        onDiscarded: () => draftDiscarded(),
        skipPoll: () => submitting.current || Boolean(request.current),
        uploadInFlight: () => uploadInFlight.current,
      }),
    [session, reportError, saveError],
  )

  const setSubmitting = useCallback(
    (value: boolean) => {
      submitting.current = value
      setBusy(value)
      syncAutosave()
    },
    [syncAutosave],
  )

  const reviewDiscard = useCallback(() => {
    if (submitting.current || request.current || uploadInFlight.current || discardReview.current)
      return
    discardReview.current = { subject: session.fields.subject, revision: session.reviewed.revision }
    setConfirmDiscard(discardReview.current)
    syncAutosave()
  }, [session, syncAutosave])

  const closeDiscard = useCallback(() => {
    discardReview.current = null
    setConfirmDiscard(null)
    syncAutosave()
  }, [syncAutosave])

  const discard = async (revision: number) => {
    setSubmitting(true)
    try {
      await session.whenSaved()
      return await getAmc().discardDraft(session.id, revision)
    } finally {
      setSubmitting(false)
    }
  }

  const keepAsNew = async (onKept: (draft: ComposeDraft) => void) => {
    if (submitting.current) return
    setSubmitting(true)
    setError('')
    try {
      const api = getAmc()
      const next = replacementId.current
        ? await api.composeDraft(replacementId.current)
        : await api.startCompose({ mode: 'new', accountId: session.fields.accountId })
      replacementId.current = next.id
      onKept(await api.saveCompose(next.id, session.recoveryPatch(next)))
    } catch (cause) {
      reportError(cause)
    } finally {
      setSubmitting(false)
    }
  }

  const minimise = async (onMinimise: (subject: string) => void) => {
    if (submitting.current || uploadInFlight.current) return
    setSubmitting(true)
    try {
      if (session.dirty && !request.current) await session.save()
      onMinimise(session.fields.subject)
    } catch (cause) {
      saveError(cause)
    } finally {
      setSubmitting(false)
    }
  }

  const reload = useCallback(async () => {
    if (submitting.current || uploadInFlight.current || request.current || discardReview.current)
      return
    setSubmitting(true)
    try {
      await session.whenSaved()
      const next = await getAmc().composeDraft(session.id)
      session.rebase(next)
      showConflict(false)
      setError('')
      session.changed()
    } catch (cause) {
      saveError(cause)
    } finally {
      setSubmitting(false)
    }
  }, [session, setSubmitting, showConflict, saveError])

  const send = useCallback(
    async ({
      editor,
      surface,
      schedule,
      sendAt,
      onQueued,
    }: {
      editor: Editor | null
      surface: HTMLDivElement | null
      schedule: boolean
      sendAt: string
      onQueued: (item: OutboxItem, requestElapsedMs: number) => void
    }) => {
      if (!editor || discardReview.current || submitting.current || uploadInFlight.current) return
      const pendingRecipient = [
        ...(surface?.querySelectorAll<HTMLInputElement>('[data-recipient-input]') ?? []),
      ].find((input) => input.value.trim())
      const { to, cc, bcc } = session.fields
      if (!request.current && pendingRecipient) {
        setError('Press Return to add the address before sending.')
        pendingRecipient.focus()
        return
      }
      if (!request.current && ![...to, ...cc, ...bcc].length) {
        setError('Add a recipient before sending.')
        return
      }
      if (!request.current && schedule && (!sendAt || new Date(sendAt).getTime() <= Date.now())) {
        setError('Choose a send time in the future.')
        return
      }

      setSubmitting(true)
      setError('')
      try {
        if (!request.current) {
          const revision = session.reviewed.revision
          const { update, fields } = session.patch(revision)
          request.current = {
            id: crypto.randomUUID(),
            draftId: session.id,
            revision,
            ...(session.dirty ? { edits: { update, fields } } : {}),
            ...(schedule ? { sendAt: new Date(sendAt).getTime() } : {}),
          }
        }
        // Let earlier writes settle while retaining the snapshot the user reviewed.
        await session.whenSaved()
        const startedAt = performance.now()
        const wallStart = Date.now()
        const item = await getAmc().sendDraft(request.current)
        onQueued(item, Math.max(performance.now() - startedAt, Date.now() - wallStart))
      } catch (cause) {
        const message = (cause as Error).message
        if (message.includes(DRAFT_CHANGED)) {
          request.current = null
          setError(`${DRAFT_CHANGED}. ${failureText(cause)}`)
          showConflict(true)
          try {
            const next = await getAmc().composeDraft(session.id)
            session.rebase(next)
            showConflict(false)
          } catch (error) {
            recordCaughtFailure(error)
            // Keep the review message and allow a manual reload.
          }
        } else if (message.includes(MIRROR_CHANGED)) {
          request.current = null
          setError(`${MIRROR_CHANGED} ${failureText(cause)}`)
        } else if (request.current) {
          setError(`${message} Check the Outbox or confirm this send again.`)
        } else saveError(cause)
      } finally {
        setConfirmSend(Boolean(request.current))
        setSubmitting(false)
      }
    },
    [session, setSubmitting, showConflict, saveError],
  )

  const upload = useCallback(
    async (editor: Editor | null, files: File[], paste = false) => {
      if (!files.length || submitting.current || request.current || uploadInFlight.current) return
      setError('')
      setUploading(true)
      uploadInFlight.current = true
      const available =
        18 * 1024 * 1024 - session.attachments.reduce((sum, part) => sum + part.size, 0)
      try {
        if (files.reduce((sum, file) => sum + file.size, 0) > available)
          throw new Error('Attachments must total 18 MB or less.')
        for (const file of files) {
          const inline = paste && INLINE_IMAGE_TYPES.includes(file.type)
          const part = await getAmc().addComposeAttachment(
            session.id,
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
          session.updateAttachments([...session.attachments, part])
        }
      } catch (cause) {
        reportError(cause)
      } finally {
        uploadInFlight.current = false
        setUploading(false)
      }
    },
    [session, reportError],
  )

  const removeAttachment = useCallback(
    (editor: Editor | null, part: ComposeAttachment) => {
      session.updateAttachments(session.attachments.filter((item) => item.id !== part.id))
      if (part.contentId && editor) {
        const tr = editor.state.tr
        editor.state.doc.descendants((node, pos) => {
          if (node.type.name === INLINE_IMAGE_NAME && node.attrs.src === `cid:${part.contentId}`) {
            tr.delete(tr.mapping.map(pos), tr.mapping.map(pos + node.nodeSize))
          }
        })
        if (tr.docChanged) editor.view.dispatch(tr)
      }
    },
    [session],
  )

  return {
    session,
    busy,
    confirmSend,
    uploading,
    confirmDiscard,
    error,
    conflict,
    reportError,
    showValidationError: setError,
    reviewDiscard,
    closeDiscard,
    discard,
    minimise,
    keepAsNew,
    reload,
    send,
    upload,
    removeAttachment,
  }
}
