import { type AccountSummary, BUCKETS, type Label } from '@amc/protocol'
import { defaultFilter } from 'cmdk'
import {
  Layers,
  type LucideIcon,
  MessageCircleQuestionMark,
  Moon,
  RefreshCw,
  Search,
  Sun,
  Tag,
  Undo2,
  Users,
} from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandShortcut,
} from '@/components/ui/command'
import { getAmc } from '@/lib/amc'
import { failureText, recordCaughtFailure } from '@/lib/failure'
import type { AskAgentRuntime, View } from '../../../shared/api'
import { navigableLabels, systemViews } from './app-sidebar'
import { Kbd } from './ui/kbd'

const runtimeDescription: Record<AskAgentRuntime, string> = {
  'approval-required': 'T3 · Approval Required',
  'auto-accept-edits': 'T3 · Auto-Accept Edits',
  auto: 'T3 · Auto',
  'full-access': 'T3 · Full Access',
  unknown: 'Uses local T3 permissions',
}

interface CommandAction {
  name: string
  shortcut?: string
  icon: LucideIcon
  run: () => void
}

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
  accountId: string | null
  accounts: AccountSummary[]
  labels: Label[]
  onView: (view: View) => void
  onAccount: (id: string | null) => void
  onSearch: (text: string) => void
  onToggleTheme: () => void
  dark: boolean
  snoozeEnabled: boolean
  organise: CommandAction[]
  actions: CommandAction[]
  appActions: CommandAction[]
  onCloseAutoFocus: (event: Event) => void
  undo?: (() => void) | undefined
}

/** ⌘K: every action, reachable by typing. */
export function CommandPalette({
  open,
  onOpenChange,
  accountId,
  accounts,
  labels,
  onView,
  onAccount,
  onSearch,
  onToggleTheme,
  dark,
  snoozeEnabled,
  organise,
  actions,
  appActions,
  onCloseAutoFocus,
  undo,
}: Props) {
  const [query, setQuery] = useState('')
  const [runtime, setRuntime] = useState<AskAgentRuntime>('unknown')
  useEffect(() => {
    if (!open) return
    let current = true
    void getAmc()
      .askAgentRuntime()
      .then((mode) => {
        if (current) setRuntime(mode)
      })
      .catch(recordCaughtFailure)
    return () => {
      current = false
    }
  }, [open])
  const run = (fn: () => void) => () => {
    onOpenChange(false)
    setQuery('')
    setRuntime('unknown')
    fn()
  }
  const asking = useRef(false)
  const ask = async () => {
    if (asking.current) return
    asking.current = true
    onOpenChange(false)
    setQuery('')
    setRuntime('unknown')
    const id = toast.loading('Opening Ask Agent in T3 Code…')
    try {
      const result = await getAmc().askAgent(query.trim(), accountId)
      if (result.opened) toast.dismiss(id)
      else toast.error(result.reason, { id })
    } catch (error) {
      toast.error('Could not open Ask Agent', { id, description: failureText(error) })
    } finally {
      asking.current = false
    }
  }
  const renderAction = (item: CommandAction) => (
    <CommandItem key={item.name} value={item.name} onSelect={run(item.run)}>
      <item.icon />
      {item.name}
      {item.shortcut && <CommandShortcut>{item.shortcut}</CommandShortcut>}
    </CommandItem>
  )
  return (
    <CommandDialog
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          setQuery('')
          setRuntime('unknown')
        }
        onOpenChange(next)
      }}
      onCloseAutoFocus={onCloseAutoFocus}
      title="Command palette"
      description="Run a command, search mail, or ask an agent in T3 Code."
      showCloseButton={false}
      filter={(value, search, keywords) =>
        value === 'mail-search-fallback'
          ? 0.002
          : value === 'ask-agent-fallback'
            ? 0.001
            : defaultFilter(value, search, keywords)
      }
    >
      <CommandInput
        placeholder="Type a command, search, or ask about mail…"
        maxLength={4000}
        value={query}
        onValueChange={setQuery}
      />
      <CommandList className="max-h-[min(26rem,60dvh)] p-1.5">
        <CommandEmpty>No commands found.</CommandEmpty>
        {actions.length > 0 && (
          <CommandGroup heading="Message">{actions.map(renderAction)}</CommandGroup>
        )}
        {(organise.length > 0 || undo) && (
          <CommandGroup heading="Organise">
            {organise.map(renderAction)}
            {undo && (
              <CommandItem value="Undo" keywords={['organise']} onSelect={run(undo)}>
                <Undo2 />
                Undo
                <CommandShortcut>Z</CommandShortcut>
              </CommandItem>
            )}
          </CommandGroup>
        )}
        <CommandGroup heading="Go to">
          {systemViews(snoozeEnabled).map((item) => (
            <CommandItem
              key={item.view.kind}
              value={`go ${item.title}`}
              onSelect={run(() => onView(item.view))}
            >
              <item.icon />
              {item.title}
              <CommandShortcut>{item.keys}</CommandShortcut>
            </CommandItem>
          ))}
          {navigableLabels(labels, accounts).map((l) => (
            <CommandItem
              key={l.id}
              value={`label ${l.name}`}
              onSelect={run(() => onView({ kind: 'label', labelId: l.id }))}
            >
              <Tag />
              {l.name}
            </CommandItem>
          ))}
        </CommandGroup>
        <CommandGroup heading="Buckets">
          {BUCKETS.map((bucket) => (
            <CommandItem
              key={bucket}
              value={`go to bucket ${bucket}`}
              onSelect={run(() => onView({ kind: 'bucket', bucket }))}
            >
              <Layers />
              {bucket}
            </CommandItem>
          ))}
        </CommandGroup>
        <CommandGroup heading="Accounts">
          <CommandItem value="account all" onSelect={run(() => onAccount(null))}>
            <Users />
            All accounts
            <CommandShortcut>⌘0</CommandShortcut>
          </CommandItem>
          {accounts.map((a, i) => (
            <CommandItem
              key={a.id}
              value={`account ${a.address}`}
              onSelect={run(() => onAccount(a.id))}
            >
              <Users />
              {a.address}
              {i < 9 && <CommandShortcut>⌘{i + 1}</CommandShortcut>}
            </CommandItem>
          ))}
        </CommandGroup>
        <CommandGroup heading="App">
          {appActions.map(renderAction)}
          <CommandItem value="sync now refresh" onSelect={run(() => void getAmc().syncNow())}>
            <RefreshCw />
            Sync now
          </CommandItem>
          <CommandItem
            value={dark ? 'Light mode' : 'Dark mode'}
            keywords={['toggle', 'theme']}
            onSelect={run(onToggleTheme)}
          >
            {dark ? <Sun /> : <Moon />}
            {dark ? 'Light mode' : 'Dark mode'}
          </CommandItem>
        </CommandGroup>
        {query.trim() && (
          <CommandGroup heading="Mail">
            <CommandItem value="mail-search-fallback" onSelect={run(() => onSearch(query.trim()))}>
              <Search />
              <span className="min-w-0 truncate">Search for “{query.trim()}”</span>
            </CommandItem>
            <CommandItem value="ask-agent-fallback" onSelect={() => void ask()}>
              <MessageCircleQuestionMark />
              <span className="min-w-0">
                <span className="block">Ask Agent in T3</span>
                <span className="block truncate text-xs text-muted-foreground">
                  {runtimeDescription[runtime]}
                </span>
              </span>
              <CommandShortcut className="truncate tracking-normal">
                {accounts.find((account) => account.id === accountId)?.address ?? 'All accounts'}
              </CommandShortcut>
            </CommandItem>
          </CommandGroup>
        )}
      </CommandList>
      <div className="flex items-center gap-3 border-t px-4 py-2 text-xs text-muted-foreground">
        <span>
          <Kbd>↑</Kbd> <Kbd>↓</Kbd> Navigate
        </span>
        <span>
          <Kbd>↵</Kbd> Select
        </span>
        <span className="ml-auto">
          <Kbd>esc</Kbd> Close
        </span>
      </div>
    </CommandDialog>
  )
}
