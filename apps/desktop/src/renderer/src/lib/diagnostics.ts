import { toast } from 'sonner'
import { getAmc } from '@/lib/amc'
import { failureText } from '@/lib/failure'

export function copyDiagnostics() {
  void getAmc()
    .copyDiagnostics()
    .then(
      () => toast.success('Diagnostics copied', { id: 'copy-diagnostics', duration: 2000 }),
      (error: unknown) =>
        toast.error('Could not copy diagnostics', {
          id: 'copy-diagnostics',
          description: failureText(error),
        }),
    )
}
