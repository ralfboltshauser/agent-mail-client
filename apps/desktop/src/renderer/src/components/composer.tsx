import type { AccountSummary, ComposeAttachment, ComposeDraft, OutboxItem } from '@amc/protocol'
import { Minus } from 'lucide-react'
import { useCallback, useRef, useState } from 'react'
import { DraftDetails, DraftStatus, SignatureEditor } from '@/features/composer/draft-details'
import { ComposerEditor, ComposerToolbar, useComposerEditor } from '@/features/composer/editor'
import { ComposerFooter } from '@/features/composer/footer'
import { ComposerRecipients, FromField, SubjectField } from '@/features/composer/header-fields'
import { useComposerSession } from '@/features/composer/use-composer-session'
import { getAmc } from '@/lib/amc'
import { DiscardDraftDialog } from './discard-draft-dialog'
import { Button } from './ui/button'
import { Dialog, DialogContent, DialogTitle } from './ui/dialog'

export function Composer({
  draft,
  accounts,
  onMinimise,
  onQueued,
  onDiscarded,
}: {
  draft: ComposeDraft
  accounts: AccountSummary[]
  onMinimise: (subject: string) => void
  onQueued: (item: OutboxItem, requestElapsedMs: number) => void
  onDiscarded: () => void
}) {
  const {
    session,
    busy,
    confirmSend,
    uploading,
    confirmDiscard,
    error,
    conflict,
    reportError,
    reviewDiscard,
    closeDiscard,
    discard,
    minimise,
    reload,
    send: submit,
    upload,
    removeAttachment,
  } = useComposerSession(draft)
  const editor = useComposerEditor(session)
  const surface = useRef<HTMLDivElement>(null)
  const [schedule, setSchedule] = useState(false)
  const [sendAt, setSendAt] = useState('')
  const [signature, setSignature] = useState<string | null>(null)
  const locked = busy || confirmSend

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
    const focused = document.activeElement
    if (
      focused instanceof HTMLInputElement &&
      focused.hasAttribute('data-recipient-input') &&
      surface.current?.contains(focused)
    ) {
      // Escape dismisses without moving focus. Let the field commit a valid address.
      focused.blur()
    }
    void minimise(onMinimise)
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !confirmDiscard) minimiseDraft()
      }}
    >
      <DialogContent
        ref={surface}
        showCloseButton={false}
        aria-describedby={undefined}
        className="flex max-h-[90dvh] max-w-[calc(100%-2rem)] flex-col gap-0 overflow-hidden p-0 sm:max-w-2xl"
        onPointerDownOutside={(event) => event.preventDefault()}
        onKeyDownCapture={(event) => {
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
            !event.nativeEvent.isComposing &&
            event.metaKey &&
            !event.ctrlKey &&
            !event.altKey &&
            !event.shiftKey &&
            event.key === 'Backspace'
          ) {
            event.preventDefault()
            event.stopPropagation()
            if (!event.repeat && !locked && !uploading && !confirmDiscard) reviewDiscard()
          }
        }}
        onKeyDown={(event) => {
          if (!event.nativeEvent.isComposing && event.metaKey && event.key === 'Enter') {
            event.preventDefault()
            event.stopPropagation()
            send()
          }
        }}
      >
        <header className="flex shrink-0 items-center justify-between gap-3 border-b bg-muted/35 px-5 py-3">
          <DialogTitle className="text-[15px] tracking-tight">Compose</DialogTitle>
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label="Minimise and save draft"
            disabled={busy || uploading}
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
            addAttachments(Array.from(event.dataTransfer.files))
          }}
          onPasteCapture={(event) => {
            const files = Array.from(event.clipboardData.files)
            if (files.length) {
              event.preventDefault()
              addAttachments(files, true)
            }
          }}
        >
          <fieldset disabled={locked} className="min-w-0">
            <FromField session={session} accounts={accounts} onAccountChange={changeAccount} />
            <ComposerRecipients session={session} />
            <SubjectField session={session} />
            <ComposerToolbar editor={editor} />
            <ComposerEditor editor={editor} locked={locked} />
            <DraftDetails session={session} onRemove={remove} />
            {signature !== null && (
              <SignatureEditor initialSignature={signature} onSave={saveSignature} />
            )}
          </fieldset>
        </section>
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
          onDiscard={reviewDiscard}
          onSignature={toggleSignature}
          onUpload={addAttachments}
        />
      </DialogContent>
      {confirmDiscard && (
        <DiscardDraftDialog
          subject={confirmDiscard.subject}
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
