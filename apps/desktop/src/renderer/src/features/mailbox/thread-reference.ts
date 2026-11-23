import { toast } from 'sonner'
import { mailShortcuts, shortcutLabel } from '@/lib/mail-shortcuts'

export const copyThreadReferenceLabel = 'Copy thread reference'
export const copyThreadReferenceShortcut = shortcutLabel(mailShortcuts.copyThreadReference)

export async function copyThreadReference(id: string) {
  // Single-quote the ID for POSIX shells and end CLI option parsing before it.
  const quotedId = `'${id.replaceAll("'", "'\\''")}'`
  try {
    await navigator.clipboard.writeText(`amc thread --json -- ${quotedId}`)
    toast.success('Thread reference copied')
  } catch {
    toast.error('Could not copy thread reference')
  }
}
