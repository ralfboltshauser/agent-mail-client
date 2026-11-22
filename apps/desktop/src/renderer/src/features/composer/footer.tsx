import { Paperclip, Trash2 } from 'lucide-react'
import { memo, useRef } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Kbd } from '@/components/ui/kbd'

export const ComposerFooter = memo(function ComposerFooter({
  busy,
  locked,
  uploading,
  ready,
  confirmSend,
  schedule,
  sendAt,
  onSend,
  onScheduleChange,
  onSendAtChange,
  onDiscard,
  onSignature,
  onUpload,
}: {
  busy: boolean
  locked: boolean
  uploading: boolean
  ready: boolean
  confirmSend: boolean
  schedule: boolean
  sendAt: string
  onSend: () => void
  onScheduleChange: (schedule: boolean) => void
  onSendAtChange: (sendAt: string) => void
  onDiscard: () => void
  onSignature: () => void
  onUpload: (files: File[]) => void
}) {
  const fileInput = useRef<HTMLInputElement>(null)
  return (
    <footer className="flex shrink-0 flex-wrap items-center gap-2 border-t bg-muted/35 px-5 py-3">
      <Button size="sm" onClick={() => onSend()} disabled={busy || uploading || !ready}>
        {confirmSend ? 'Confirm send' : schedule ? 'Schedule send' : 'Send'} <Kbd>⌘↵</Kbd>
      </Button>
      <Button
        size="sm"
        variant="outline"
        disabled={locked}
        onClick={() => onScheduleChange(!schedule)}
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
          onChange={(event) => onSendAtChange(event.target.value)}
        />
      )}
      <div className="ml-auto flex gap-1">
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Discard draft"
          aria-keyshortcuts="Meta+Backspace"
          title="Discard draft (⌘⌫)"
          disabled={locked || uploading}
          onClick={onDiscard}
        >
          <Trash2 />
        </Button>
        <Button variant="ghost" size="sm" disabled={locked} onClick={onSignature}>
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
            onUpload(Array.from(event.target.files ?? []))
            event.target.value = ''
          }}
        />
      </div>
    </footer>
  )
})
