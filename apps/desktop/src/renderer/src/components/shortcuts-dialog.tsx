import { BUCKETS } from '@amc/protocol'
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
        ['Filter mail', '/'],
        ['Next / previous thread', 'J / K'],
        ['Page down in reader', 'Space'],
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
        ['Hand off', 'T'],
        ['Send in composer', '⌘↵'],
      ],
    },
    {
      title: 'Organise',
      keys: [
        ['Archive', 'E'],
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
