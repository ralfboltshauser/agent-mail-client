import { toast } from 'sonner'

export const copyThreadReferenceLabel = 'Copy thread reference'
export const copyThreadReferenceShortcut = '⌘⇧C'

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
