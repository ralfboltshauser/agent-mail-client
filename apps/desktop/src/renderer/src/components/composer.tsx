import type { AccountSummary, ComposeAttachment, ComposeDraft, OutboxItem } from '@amc/protocol'
import { Minus } from 'lucide-react'
import { useCallback, useRef, useState } from 'react'
import { toast } from 'sonner'
import { DRAFT_DISCARDED_ELSEWHERE } from '@/features/composer/draft-availability'
import { DraftDetails, DraftStatus, SignatureEditor } from '@/features/composer/draft-details'
import { ComposerEditor, ComposerToolbar, useComposerEditor } from '@/features/composer/editor'
import { ComposerFooter } from '@/features/composer/footer'
import {
  ComposerRecipients,
  FromField,
  type RecipientFocus,
  SubjectField,
} from '@/features/composer/header-fields'
import { useComposerSession } from '@/features/composer/use-composer-session'
import { getAmc } from '@/lib/amc'
import { composeFieldShortcuts } from '@/lib/mail-shortcuts'
import { DiscardDraftDialog } from './discard-draft-dialog'
import { parseRecipientInput } from './recipient-field'
import { Button } from './ui/button'
import { Dialog, DialogContent, DialogTitle } from './ui/dialog'

export function Composer({
  draft,
  accounts,
  onMinimise,
  onQueued,
  onDiscarded,
  onKept,
}: {
  draft: ComposeDraft
  accounts: AccountSummary[]
  onMinimise: (subject: string) => void
  onQueued: (item: OutboxItem, requestElapsedMs: number) => void
  onDiscarded: () => void
  onKept: (draft: ComposeDraft) => void
}) {
  const surface = useRef<HTMLDivElement>(null)
  const recipients = useRef<RecipientFocus>(null)
  const discardInvoker = useRef<HTMLElement | null>(null)
  const [discardedElsewhere, setDiscardedElsewhere] = useState(false)
  const recipientInputs = () =>
    Array.from(surface.current?.querySelectorAll<HTMLInputElement>('[data-recipient-input]') ?? [])
  const pendingRecipient = () => recipientInputs().find((input) => input.value.trim())
  const {
    session,
    busy,
    confirmSend,
    uploading,
    confirmDiscard,
    error,
    conflict,
    reportError,
    showValidationError,
    reviewDiscard,
    closeDiscard,
    discard,
    minimise,
    keepAsNew,
    reload,
    send: submit,
    upload,
    removeAttachment,
  } = useComposerSession(draft, (dirty) => {
    if (dirty || pendingRecipient()) {
      setDiscardedElsewhere(true)
    } else {
      toast.info(DRAFT_DISCARDED_ELSEWHERE)
      onDiscarded()
    }
  })
  const editor = useComposerEditor(session)
  const [schedule, setSchedule] = useState(false)
  const [sendAt, setSendAt] = useState('')
  const [signature, setSignature] = useState<string | null>(null)
  const locked = busy || confirmSend
  const openDiscard = useCallback(() => {
    const focused = document.activeElement
    discardInvoker.current = focused instanceof HTMLElement ? focused : null
    reviewDiscard()
  }, [reviewDiscard])

  const changeAccount = useCallback(
    (accountId: string) => {
      session.updateField('accountId', accountId)
      setSignature(null)
    },
    [session],
  )
  const addAttachments = useCallback(
    (files: File[], paste = false) => {
      void upload(editor, files, paste)
    },
    [editor, upload],
  )
  const remove = useCallback(
    (part: ComposeAttachment) => {
      removeAttachment(editor, part)
    },
    [editor, removeAttachment],
  )
  const send = useCallback(() => {
    void submit({ editor, surface: surface.current, schedule, sendAt, onQueued })
  }, [submit, editor, schedule, sendAt, onQueued])
  const toggleSignature = useCallback(() => {
    if (signature !== null) setSignature(null)
    else
      void getAmc()
        .signature(session.fields.accountId)
        .then(({ signature }) => setSignature(signature))
        .catch(reportError)
  }, [signature, session, reportError])
  const saveSignature = useCallback(
    (value: string) => {
      void getAmc()
        .saveSignature(session.fields.accountId, value)
        .then(() => setSignature(null))
        .catch(reportError)
    },
    [session, reportError],
  )

  const minimiseDraft = () => {
    const invalid = recipientInputs().find(
      (input) => input.value.trim() && !parseRecipientInput(input.value),
    )
    if (invalid) {
      showValidationError('Finish adding the address or clear the field before saving.')
      invalid.focus()
      return
    }
    const focused = document.activeElement
    if (
      focused instanceof HTMLInputElement &&
      focused.hasAttribute('data-recipient-input') &&
      surface.current?.contains(focused)
    ) {
      // Dismissal can leave the field focused. Let it commit a valid address.
      focused.blur()
    }
    void minimise(onMinimise)
  }

  const recoverDraft = () => {
    const input = pendingRecipient()
    if (input) {
      showValidationError('Finish adding the address or clear the field before saving.')
      input.focus()
      return
    }
    void keepAsNew(onKept)
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !confirmDiscard && !discardedElsewhere) minimiseDraft()
      }}
    >
      <DialogContent
        ref={surface}
        showCloseButton={false}
        aria-describedby={undefined}
        className="flex max-h-[90dvh] max-w-[calc(100%-2rem)] flex-col gap-0 overflow-hidden p-0 sm:max-w-2xl"
        onOpenAutoFocus={(event) => {
          event.preventDefault()
          if ((draft.to.length || draft.cc.length || draft.bcc.length) && editor)
            editor.view.focus()
          else recipients.current?.focus('to')
        }}
        onEscapeKeyDown={(event) => {
          // Radix sees Escape before the recipient field can close its suggestions.
          if (
            event.target instanceof HTMLInputElement &&
            event.target.matches('[data-recipient-input][aria-expanded="true"]')
          )
            event.preventDefault()
        }}
        onKeyDownCapture={(event) => {
          if (event.nativeEvent.isComposing) return
          if (event.metaKey && event.shiftKey && !event.ctrlKey && !event.altKey) {
            const binding = `mod+shift+${event.key.toLowerCase()}`
            const field = (
              Object.keys(composeFieldShortcuts) as (keyof typeof composeFieldShortcuts)[]
            ).find((name) => composeFieldShortcuts[name] === binding)
            if (field) {
              event.preventDefault()
              event.stopPropagation()
              if (locked || confirmDiscard) return
              if (field === 'body') editor?.view.focus()
              else if (field === 'from' || field === 'subject') {
                surface.current?.querySelector<HTMLElement>(`[name="${field}"]`)?.focus()
              } else recipients.current?.focus(field)
              return
            }
          }
          const target = event.target
          if (target instanceof Element) {
            const editingHost = target.closest('[contenteditable]')
            if (
              target.closest('input, textarea') ||
              (editingHost && editingHost.getAttribute('contenteditable') !== 'false')
            )
              return
          }
          if (
            event.metaKey &&
            !event.ctrlKey &&
            !event.altKey &&
            !event.shiftKey &&
            event.key === 'Backspace'
          ) {
            event.preventDefault()
            event.stopPropagation()
            if (!event.repeat && !locked && !uploading && !confirmDiscard && !discardedElsewhere)
              openDiscard()
          }
        }}
        onKeyDown={(event) => {
          if (!event.nativeEvent.isComposing && event.metaKey && event.key === 'Enter') {
            event.preventDefault()
            event.stopPropagation()
            if (!discardedElsewhere) send()
          }
        }}
      >
        <header className="flex shrink-0 items-center justify-between gap-3 border-b bg-muted/35 px-5 py-3">
          <DialogTitle className="text-[15px] tracking-tight">Compose</DialogTitle>
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label="Minimise and save draft"
            disabled={busy || uploading || discardedElsewhere}
            onClick={minimiseDraft}
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
            if (!discardedElsewhere) addAttachments(Array.from(event.dataTransfer.files))
          }}
          onPasteCapture={(event) => {
            const files = Array.from(event.clipboardData.files)
            if (files.length) {
              event.preventDefault()
              if (!discardedElsewhere) addAttachments(files, true)
            }
          }}
        >
          <fieldset disabled={locked} className="min-w-0">
            <FromField session={session} accounts={accounts} onAccountChange={changeAccount} />
            <ComposerRecipients ref={recipients} session={session} />
            <SubjectField session={session} />
            <ComposerEditor editor={editor} locked={locked} />
            <ComposerToolbar editor={editor} />
            <DraftDetails session={session} onRemove={remove} />
            {signature !== null && (
              <SignatureEditor initialSignature={signature} onSave={saveSignature} />
            )}
          </fieldset>
        </section>
        {discardedElsewhere ? (
          <div className="space-y-2 border-t px-5 py-3 text-sm">
            <div role="alert">
              <p>{DRAFT_DISCARDED_ELSEWHERE}</p>
              {session.attachments.length > 0 && <p>Add any attachments again in the new draft.</p>}
              {error && <p>{error}</p>}
            </div>
            <div className="flex gap-2">
              <Button size="sm" disabled={busy} onClick={recoverDraft}>
                Keep as new draft
              </Button>
              <Button size="sm" variant="outline" disabled={busy} onClick={onDiscarded}>
                Close
              </Button>
            </div>
          </div>
        ) : (
          <>
            <DraftStatus session={session} error={error} conflict={conflict} onReload={reload} />
            <ComposerFooter
              busy={busy}
              locked={locked}
              uploading={uploading}
              ready={Boolean(editor)}
              confirmSend={confirmSend}
              schedule={schedule}
              sendAt={sendAt}
              onSend={send}
              onScheduleChange={setSchedule}
              onSendAtChange={setSendAt}
              onDiscard={openDiscard}
              onSignature={toggleSignature}
              onUpload={addAttachments}
            />
          </>
        )}
      </DialogContent>
      {confirmDiscard && (
        <DiscardDraftDialog
          subject={confirmDiscard.subject}
          onCloseAutoFocus={(event) => {
            const invoker = discardInvoker.current
            const composer = surface.current
            const active = document.activeElement
            if (
              composer?.contains(invoker) &&
              (active === document.body || composer.contains(active))
            ) {
              event.preventDefault()
              invoker?.focus()
            }
          }}
          onConfirm={async () => {
            const result = await discard(confirmDiscard.revision)
            onDiscarded()
            return result
          }}
          onClose={closeDiscard}
        />
      )}
    </Dialog>
  )
}
