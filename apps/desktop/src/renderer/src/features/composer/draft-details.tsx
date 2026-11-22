import { type ComposeAttachment, ORIGINAL_DRAFT_LEFT } from '@amc/protocol'
import { X } from 'lucide-react'
import { memo, useState } from 'react'
import { Button } from '@/components/ui/button'
import type { DraftSession } from './draft-session'
import { useDraftValue } from './use-draft-value'

export const DraftDetails = memo(function DraftDetails({
  session,
  onRemove,
}: {
  session: DraftSession
  onRemove: (part: ComposeAttachment) => void
}) {
  const draftSignature = useDraftValue(session, (draft) => draft.reviewed.signature)
  const quote = useDraftValue(session, (draft) => draft.reviewed.quote)
  const attachments = useDraftValue(session, (draft) => draft.attachments)
  return (
    <>
      {draftSignature && (
        <p className="mx-4 mb-3 whitespace-pre-wrap text-sm text-muted-foreground">
          {draftSignature}
        </p>
      )}
      {quote && (
        <details className="mx-4 mb-3 rounded-md bg-muted/50 p-2 text-xs text-muted-foreground">
          <summary className="cursor-pointer">Quoted message</summary>
          <pre className="mt-2 max-h-36 overflow-auto whitespace-pre-wrap font-sans">{quote}</pre>
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
                onClick={() => onRemove(part)}
              >
                <X />
              </Button>
            </li>
          ))}
        </ul>
      )}
    </>
  )
})

export const SignatureEditor = memo(function SignatureEditor({
  initialSignature,
  onSave,
}: {
  initialSignature: string
  onSave: (signature: string) => void
}) {
  const [signature, setSignature] = useState(initialSignature)
  return (
    <label className="mx-4 mb-3 flex flex-col gap-1 text-xs">
      Signature for this Account
      <textarea
        className="min-h-16 rounded-md border bg-background p-2"
        value={signature}
        maxLength={5000}
        onChange={(event) => setSignature(event.target.value)}
      />
      <div className="flex gap-2">
        <Button size="sm" variant="outline" onClick={() => onSave(signature)}>
          Save for future drafts
        </Button>
      </div>
    </label>
  )
})

export const DraftStatus = memo(function DraftStatus({
  session,
  error,
  conflict,
  onReload,
}: {
  session: DraftSession
  error: string
  conflict: boolean
  onReload: () => void
}) {
  const originalDraftLeft = useDraftValue(session, (draft) => draft.mirror.originalDraftLeft)
  const mirrorError = useDraftValue(session, (draft) => draft.mirror.mirrorError)
  const mirrorConflict = useDraftValue(session, (draft) => draft.mirror.mirrorConflict)
  return (
    <>
      {error && (
        <p role="alert" className="border-t px-4 py-2 text-sm text-destructive">
          {error}
        </p>
      )}
      {conflict && (
        <div className="px-4 pb-2">
          <Button size="sm" variant="outline" onClick={onReload}>
            Reload message details
          </Button>
        </div>
      )}
      {originalDraftLeft && (
        <output className="border-t px-4 py-2 text-xs text-muted-foreground">
          {ORIGINAL_DRAFT_LEFT}
        </output>
      )}
      {mirrorConflict && !originalDraftLeft && (
        <output className="border-t px-4 py-2 text-xs text-muted-foreground">
          The Account’s draft changed. Your local copy was kept.
        </output>
      )}
      {mirrorError && !error && (
        <output className="border-t px-4 py-2 text-xs text-muted-foreground">
          Saved in AMC. Waiting to sync to the Account’s Drafts.
        </output>
      )}
    </>
  )
})
