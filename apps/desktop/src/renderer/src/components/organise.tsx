import { type Label, type OrganiseAction, SNOOZED_LABEL, type ThreadSummary } from '@amc/protocol'
import {
  Archive,
  BellOff,
  Clock3,
  Mail,
  MailOpen,
  RotateCcw,
  Star,
  Tag,
  Trash2,
} from 'lucide-react'
import { useEffect, useId, useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'

type Picker = { kind: 'labels' | 'snooze'; thread: ThreadSummary }
type Control = {
  name: string
  key: string
  shortcut: string
  icon: typeof Archive
  run: () => void
  pressed?: boolean
}

export function useOrganise(thread: ThreadSummary | null) {
  const [picker, setPicker] = useState<Picker | null>(null)

  useEffect(() => {
    const showErrors = () => {
      void window.amc
        .organiseErrors()
        .then((errors) => {
          for (const error of errors) toast.error(error.message, { id: error.id })
        })
        .catch(() => {})
    }
    showErrors()
    return window.amc.onChanged(showErrors)
  }, [])

  const run = async (action: OrganiseAction, description: string) => {
    try {
      const id = await window.amc.organise(action)
      if (action.kind === 'undo') toast('Undo queued')
      else
        toast(description, {
          id,
          duration: 7000,
          action: {
            label: 'Undo',
            onClick: () =>
              void run({ kind: 'undo', threadId: action.threadId, mutationId: id }, ''),
          },
        })
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message.replace(/^Error invoking remote method '[^']+': Error: /, '')
          : 'Could not organise this Thread'
      toast.error(message)
    }
  }
  const undo = () => void run({ kind: 'undo' }, '')
  const controls: Control[] = []
  if (thread) {
    const threadId = thread.id
    const trashed = thread.labelIds.includes(`${thread.accountId}:TRASH`)
    if (!trashed)
      controls.push(
        {
          name: 'Archive',
          key: 'e',
          shortcut: 'E',
          icon: Archive,
          run: () => void run({ kind: 'archive', threadId }, 'Archived'),
        },
        {
          name: 'Snooze',
          key: 'h',
          shortcut: 'H',
          icon: Clock3,
          run: () => setPicker({ kind: 'snooze', thread }),
        },
      )
    controls.push(
      {
        name: trashed ? 'Restore from Trash' : 'Move to Trash',
        key: '#',
        shortcut: '#',
        icon: trashed ? RotateCcw : Trash2,
        run: () =>
          void run(
            { kind: 'trash', threadId, value: !trashed },
            trashed ? 'Restored from Trash' : 'Moved to Trash',
          ),
      },
      {
        name: thread.starred ? 'Remove star' : 'Star',
        key: 's',
        shortcut: 'S',
        icon: Star,
        pressed: thread.starred,
        run: () =>
          void run(
            { kind: 'star', threadId, value: !thread.starred },
            thread.starred ? 'Star removed' : 'Starred',
          ),
      },
      {
        name: thread.unreadCount > 0 ? 'Mark as read' : 'Mark as unread',
        key: thread.unreadCount > 0 ? 'u' : 'shift+u',
        shortcut: thread.unreadCount > 0 ? 'U' : '⇧U',
        icon: thread.unreadCount > 0 ? MailOpen : Mail,
        run: () =>
          void run(
            { kind: 'read', threadId, value: thread.unreadCount > 0 },
            thread.unreadCount > 0 ? 'Marked as read' : 'Marked as unread',
          ),
      },
      {
        name: 'Labels',
        key: 'l',
        shortcut: 'L',
        icon: Tag,
        run: () => setPicker({ kind: 'labels', thread }),
      },
      {
        name: thread.muted ? 'Unmute' : 'Mute',
        key: 'm',
        shortcut: 'M',
        icon: BellOff,
        pressed: thread.muted ?? false,
        run: () =>
          void run(
            { kind: 'mute', threadId, value: !thread.muted },
            thread.muted ? 'Unmuted' : 'Muted',
          ),
      },
    )
  }
  const shortcuts = {
    ...Object.fromEntries(controls.map((item) => [item.key, item.run])),
    u: () =>
      thread && void run({ kind: 'read', threadId: thread.id, value: true }, 'Marked as read'),
    'shift+u': () =>
      thread && void run({ kind: 'read', threadId: thread.id, value: false }, 'Marked as unread'),
    z: undo,
  }
  return { controls, shortcuts, undo, picker, setPicker, run }
}

export function OrganiseToolbar({ controls }: { controls: Control[] }) {
  return (
    <fieldset className="app-no-drag flex items-center gap-0.5">
      <legend className="sr-only">Organise Thread</legend>
      {controls.map(({ name, shortcut, icon: Icon, run, pressed }) => (
        <Tooltip key={shortcut}>
          <TooltipTrigger asChild>
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label={name}
              aria-pressed={pressed}
              onClick={run}
              className={pressed ? 'bg-accent text-accent-foreground' : 'text-muted-foreground'}
            >
              <Icon />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">
            {name} <kbd className="ml-1 opacity-70">{shortcut}</kbd>
          </TooltipContent>
        </Tooltip>
      ))}
    </fieldset>
  )
}

interface PickerProps {
  picker: Picker
  labels: Label[]
  onClose: () => void
  run: (action: OrganiseAction, description: string) => Promise<void>
}

function tomorrowMorning(): Date {
  const tomorrow = new Date()
  tomorrow.setDate(tomorrow.getDate() + 1)
  tomorrow.setHours(9, 0, 0, 0)
  return tomorrow
}

function localInputValue(date: Date): string {
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16)
}

export function OrganisePicker({ picker, labels, onClose, run }: PickerProps) {
  const timeId = useId()
  const [when, setWhen] = useState(() => localInputValue(tomorrowMorning()))
  const [noReply, setNoReply] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const { thread } = picker
  const commit = (action: OrganiseAction, description: string) => {
    onClose()
    void run(action, description)
  }
  const choices = labels.filter(
    (l) => l.kind === 'user' && l.accountId === thread.accountId && l.name !== SNOOZED_LABEL,
  )
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
    >
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>{picker.kind === 'labels' ? 'Labels' : 'Snooze Thread'}</DialogTitle>
          <DialogDescription className="truncate">
            {thread.subject || '(no subject)'}
          </DialogDescription>
        </DialogHeader>
        {picker.kind === 'labels' ? (
          <div className="grid max-h-72 gap-1 overflow-y-auto">
            {choices.length === 0 && (
              <p className="text-sm text-muted-foreground">This Account has no user Labels.</p>
            )}
            {choices.map((label) => {
              const applied = thread.labelIds.includes(label.id)
              return (
                <Button
                  key={label.id}
                  variant="ghost"
                  className="justify-start"
                  onClick={() =>
                    commit(
                      { kind: 'label', threadId: thread.id, labelId: label.id, value: !applied },
                      applied ? `Removed Label “${label.name}”` : `Added Label “${label.name}”`,
                    )
                  }
                >
                  <Tag />
                  <span className="truncate">{label.name}</span>
                  <span className="ml-auto text-xs text-muted-foreground">
                    {applied ? 'Remove' : 'Add'}
                  </span>
                </Button>
              )
            })}
          </div>
        ) : (
          <form
            className="grid gap-4"
            onSubmit={(event) => {
              event.preventDefault()
              const until = new Date(when).getTime()
              if (!Number.isFinite(until) || until <= Date.now()) {
                setError('Choose a time in the future.')
                return
              }
              commit({ kind: 'snooze', threadId: thread.id, until, noReply }, 'Snoozed')
            }}
          >
            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => setWhen(localInputValue(new Date(Date.now() + 3600_000)))}
              >
                In an hour
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => setWhen(localInputValue(tomorrowMorning()))}
              >
                Tomorrow at 9
              </Button>
            </div>
            <div className="grid gap-1.5">
              <label htmlFor={timeId} className="text-sm font-medium">
                Return to Inbox
              </label>
              <Input
                id={timeId}
                type="datetime-local"
                required
                value={when}
                aria-invalid={!!error}
                onChange={(event) => {
                  setWhen(event.target.value)
                  setError(null)
                }}
              />
              {error && (
                <p role="alert" className="text-sm text-destructive">
                  {error}
                </p>
              )}
            </div>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={noReply}
                onChange={(event) => setNoReply(event.target.checked)}
              />
              Until a reply arrives or this time
            </label>
            <DialogFooter>
              <Button type="submit">Snooze</Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  )
}
