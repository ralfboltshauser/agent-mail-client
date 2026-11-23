import type { AccountSummary, Label, OrganiseAction, ThreadSummary } from '@amc/protocol'
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
import { getAmc } from '@/lib/amc'
import { failureText, recordCaughtFailure } from '@/lib/failure'

type Picker = {
  kind: 'labels' | 'snooze'
  thread: ThreadSummary
  trigger: HTMLElement | null
  imap?: boolean
}
type Control = {
  name: string
  key: string
  shortcut: string
  icon: typeof Archive
  run: (trigger?: HTMLElement) => void
  pressed?: boolean
}

const run = async (action: OrganiseAction, description: string) => {
  try {
    const id = await getAmc().organise(action)
    if (action.kind === 'undo') toast('Undo queued')
    else
      toast(description, {
        id,
        duration: 7000,
        action: {
          label: 'Undo',
          onClick: () => void run({ kind: 'undo', threadId: action.threadId, mutationId: id }, ''),
        },
      })
  } catch (error) {
    toast.error('Could not organise this Thread', { description: failureText(error) })
  }
}
export { run as runOrganise }

export function OrganiseNotices() {
  // Reading acknowledges notices in SQLite. Handle each reply directly as an event.
  useEffect(() => {
    const showErrors = () => {
      void getAmc()
        .organiseErrors()
        .then((errors) => {
          for (const notice of errors) {
            if (notice.updateOnly && !toast.getToasts().some((active) => active.id === notice.id))
              continue
            if (notice.quiet) toast(notice.message, { id: notice.id, action: undefined })
            else if (notice.undo) {
              const undo = notice.undo
              toast.error(notice.message, {
                description: notice.description,
                id: notice.id,
                duration: 7000,
                action: { label: 'Undo', onClick: () => void run(undo, '') },
              })
            } else toast.error(notice.message, { description: notice.description, id: notice.id })
          }
        })
        .catch(recordCaughtFailure)
    }
    showErrors()
    return getAmc().onChanged(showErrors)
  }, [])
  return null
}

export function useOrganise(
  thread: ThreadSummary | null,
  snoozeEnabled = false,
  account?: Pick<AccountSummary, 'kind' | 'imapMoves'>,
  labels: Label[] = [],
) {
  const imap = account?.kind === 'imap'
  const canMove = !imap || account.imapMoves !== false
  const [picker, setPicker] = useState<Picker | null>(null)

  const openPicker = (kind: Picker['kind'], thread: ThreadSummary, trigger?: HTMLElement) => {
    const active = document.activeElement
    setPicker({
      kind,
      thread,
      imap,
      trigger: trigger ?? (active instanceof HTMLElement ? active : null),
    })
  }
  const undo = () => void run({ kind: 'undo' }, '')
  const controls: Control[] = []
  if (thread) {
    const threadId = thread.id
    const trashed = thread.labelIds.includes(`${thread.accountId}:TRASH`)
    const accountLabels = labels.filter((label) => label.accountId === thread.accountId)
    const has = (id: string) =>
      accountLabels.some((label) => label.id === `${thread.accountId}:${id}`)
    if (
      !trashed &&
      (!imap ||
        (canMove && has('ARCHIVE') && thread.labelIds.includes(`${thread.accountId}:INBOX`)))
    )
      controls.push({
        name: 'Archive',
        key: 'e',
        shortcut: 'E',
        icon: Archive,
        run: () => void run({ kind: 'archive', threadId }, 'Archived'),
      })
    if (
      !trashed &&
      snoozeEnabled &&
      (!imap ||
        (canMove && has('ARCHIVE') && thread.labelIds.includes(`${thread.accountId}:INBOX`)))
    )
      controls.push({
        name: 'Snooze',
        key: 'h',
        shortcut: 'H',
        icon: Clock3,
        run: (trigger) => openPicker('snooze', thread, trigger),
      })
    if (!imap || (canMove && has('TRASH') && (!trashed || has('INBOX')))) {
      controls.push({
        name: trashed ? 'Restore from Trash' : 'Move to Trash',
        key: '#',
        shortcut: '#',
        icon: trashed ? RotateCcw : Trash2,
        run: () =>
          void run(
            { kind: 'trash', threadId, value: !trashed },
            trashed ? 'Restored from Trash' : 'Moved to Trash',
          ),
      })
    }
    controls.push(
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
      ...(!imap || (canMove && accountLabels.some((label) => label.kind === 'user'))
        ? [
            {
              name: imap ? 'Move to folder' : 'Labels',
              key: 'l',
              shortcut: 'L',
              icon: Tag,
              run: (trigger?: HTMLElement) => openPicker('labels', thread, trigger),
            },
          ]
        : []),
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
  useEffect(() => {
    if (!snoozeEnabled) setPicker((current) => (current?.kind === 'snooze' ? null : current))
  }, [snoozeEnabled])
  return {
    controls,
    shortcuts,
    undo,
    picker: picker?.kind === 'snooze' && !snoozeEnabled ? null : picker,
    setPicker,
    run,
  }
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
              onClick={(event) => run(event.currentTarget)}
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
  focusFallback?: () => void
  run: (action: OrganiseAction, description: string) => Promise<void>
}

function tomorrowMorning(): Date {
  const tomorrow = new Date(Date.now())
  tomorrow.setDate(tomorrow.getDate() + 1)
  tomorrow.setHours(9, 0, 0, 0)
  return tomorrow
}

function localInputValue(date: Date): string {
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16)
}

function preset(date: Date) {
  return { value: localInputValue(date), instant: date.getTime() }
}

export function OrganisePicker({ picker, labels, onClose, focusFallback, run }: PickerProps) {
  const timeId = useId()
  const [when, setWhen] = useState<{ value: string; instant: number | null }>(() =>
    preset(tomorrowMorning()),
  )
  const [noReply, setNoReply] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const { thread } = picker
  const commit = (action: OrganiseAction, description: string) => {
    onClose()
    void run(action, description)
  }
  const choices = labels.filter((l) => l.kind === 'user' && l.accountId === thread.accountId)
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
    >
      <DialogContent
        className="sm:max-w-sm"
        onCloseAutoFocus={(event) => {
          event.preventDefault()
          if (picker.trigger?.isConnected && picker.trigger !== document.body)
            picker.trigger.focus()
          if (
            !picker.trigger ||
            picker.trigger === document.body ||
            document.activeElement !== picker.trigger
          )
            focusFallback?.()
        }}
      >
        <DialogHeader>
          <DialogTitle>
            {picker.kind === 'labels'
              ? picker.imap
                ? 'Move to folder'
                : 'Labels'
              : 'Snooze Thread'}
          </DialogTitle>
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
                      {
                        kind: 'label',
                        threadId: thread.id,
                        labelId: label.id,
                        value: picker.imap || !applied,
                      },
                      picker.imap
                        ? `Moved to “${label.name}”`
                        : applied
                          ? `Removed Label “${label.name}”`
                          : `Added Label “${label.name}”`,
                    )
                  }
                >
                  <Tag />
                  <span className="truncate">{label.name}</span>
                  <span className="ml-auto text-xs text-muted-foreground">
                    {picker.imap ? 'Move' : applied ? 'Remove' : 'Add'}
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
              const until = when.instant ?? new Date(when.value).getTime()
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
                onClick={() => {
                  setWhen(preset(new Date(Date.now() + 3600_000)))
                  setError(null)
                }}
              >
                In an hour
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => {
                  setWhen(preset(tomorrowMorning()))
                  setError(null)
                }}
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
                value={when.value}
                aria-invalid={!!error}
                onChange={(event) => {
                  setWhen({ value: event.target.value, instant: null })
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
