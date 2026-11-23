import { BUCKETS } from '@amc/protocol'
import {
  copyThreadReferenceLabel,
  copyThreadReferenceShortcut,
} from '@/features/mailbox/thread-reference'
import { composeFieldShortcuts, shortcutLabel } from '@/lib/mail-shortcuts'
import { feedbackShortcut } from '../../../shared/feedback'
import { systemViews } from './app-sidebar'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from './ui/dialog'
import { Kbd } from './ui/kbd'

export function ShortcutsDialog({
  open,
  onOpenChange,
  onCloseAutoFocus,
  snoozeEnabled,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onCloseAutoFocus: (event: Event) => void
  snoozeEnabled: boolean
}) {
  const groups = [
    {
      title: 'Navigate',
      keys: [
        ['Command palette', '⌘K'],
        ['Settings', '⌘,'],
        ['Send Feedback', feedbackShortcut],
        ['Toggle sidebar', '⌘B'],
        ['Check for New Mail', '⌘R / Ctrl+R'],
        ['Filter mail', '/'],
        ['Focus reader / Back to mailbox', 'O'],
        ['Return from Focus reader', 'Esc'],
        ['Next / previous thread', 'J / K'],
        ['Next / previous Inbox section', '⇧J / ⇧K'],
        ['Page down in reader', 'Space'],
        [copyThreadReferenceLabel, copyThreadReferenceShortcut],
        ['Triage Inbox', 'T'],
        ['Switch accounts', '⌘0–9'],
      ],
    },
    {
      title: 'Compose',
      keys: [
        ['New message', 'C'],
        ['Reply', 'R'],
        ['Reply all', 'A'],
        ['Forward', 'F'],
        ['Hand off', '⇧T'],
        ['Focus From', shortcutLabel(composeFieldShortcuts.from)],
        ['Focus To', shortcutLabel(composeFieldShortcuts.to)],
        ['Focus Cc', shortcutLabel(composeFieldShortcuts.cc)],
        ['Focus Bcc', shortcutLabel(composeFieldShortcuts.bcc)],
        ['Focus Subject', shortcutLabel(composeFieldShortcuts.subject)],
        ['Focus message body', shortcutLabel(composeFieldShortcuts.body)],
        ['Send in composer', '⌘↵'],
      ],
    },
    {
      title: 'Triage review',
      keys: [
        ['Accept sender', 'A'],
        ['Block sender', 'X'],
        ['Choose a Bucket', '1–6'],
        ['Archive this Thread', 'E'],
        ['Filter out this Thread', 'F'],
        ...(import.meta.env.VITE_AMC_PRIVATE_TRIAGE_REASONS !== '0'
          ? [
              ['Add a reason to Filter out or Block sender', 'Shift+F / Shift+X'] as [
                string,
                string,
              ],
            ]
          : []),
        ...(snoozeEnabled ? [['Snooze this Thread', 'S']] : []),
        ['Reply', 'R'],
        ['Skip card', 'Space'],
        ['Undo review action', 'U'],
        ['Exit and keep position', 'Esc'],
      ],
    },
    {
      title: 'Organise',
      keys: [
        ['Archive', 'E'],
        ['Filter out this Thread', '! (Shift+1)'],
        ...(snoozeEnabled ? [['Snooze', 'H']] : []),
        ['Trash', '#'],
        ['Toggle star', 'S'],
        ['Mark read / unread', 'U / ⇧U'],
        ['Label', 'L'],
        ['Toggle mute', 'M'],
        ['Undo', 'Z'],
        ['Choose a Bucket', 'B'],
        ...BUCKETS.map((bucket, index) => [bucket, String(index + 1)]),
      ],
    },
    { title: 'Go to', keys: systemViews(snoozeEnabled).map(({ title, keys }) => [title, keys]) },
  ]
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        onCloseAutoFocus={onCloseAutoFocus}
        className="max-h-[85dvh] overflow-y-auto sm:max-w-2xl"
      >
        <DialogHeader>
          <DialogTitle>Keyboard shortcuts</DialogTitle>
          <DialogDescription>
            Press the keys in order for shortcuts that start with G.
          </DialogDescription>
        </DialogHeader>
        <div className="grid items-start gap-6 sm:grid-cols-2">
          {groups.map(({ title, keys }) => (
            <section key={title}>
              <h3 className="mb-2 text-xs font-semibold text-muted-foreground">{title}</h3>
              <dl className="divide-y divide-border">
                {keys.map(([action, shortcut]) => (
                  <div
                    key={action}
                    className="flex items-center justify-between gap-3 py-1.5 text-[13px]"
                  >
                    <dt>{action}</dt>
                    <dd>
                      <Kbd>{shortcut}</Kbd>
                    </dd>
                  </div>
                ))}
              </dl>
            </section>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  )
}
