import { FileText, Paperclip } from 'lucide-react'
import { getAmc } from '@/lib/amc'
import { fileSize } from '@/lib/format'
import type { ReplicaThreadMessage } from '../../../../shared/api'

export function MessageAttachments({ message }: { message: ReplicaThreadMessage }) {
  const files = message.attachments.filter((attachment) => !attachment.inline)
  if (files.length === 0) return null
  return (
    <div className="mt-4 flex flex-wrap gap-2">
      {files.map((a) => (
        <button
          key={a.id}
          type="button"
          onClick={() => void getAmc().openAttachment(a.id, a.filename)}
          className="flex max-w-64 items-center gap-2 rounded-md border bg-background px-2.5 py-1.5 text-left text-xs hover:bg-muted"
        >
          {a.mimeType.startsWith('image/') ? (
            <Paperclip className="size-3.5 shrink-0" />
          ) : (
            <FileText className="size-3.5 shrink-0" />
          )}
          <span className="truncate">{a.filename || 'attachment'}</span>
          <span className="shrink-0 text-muted-foreground">{fileSize(a.size)}</span>
        </button>
      ))}
    </div>
  )
}
